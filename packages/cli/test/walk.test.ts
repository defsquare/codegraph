import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTerm, selectorToJson } from "@codegraph/analyzer";
import {
  DEFAULT_WALK_DEFINITION,
  EXPLAIN_WALK_DEFINITION,
  WALK_COMPLETION_TOKENS_PER_BLOCK,
  WALK_DEFINITION_KIND,
  WALK_RECORDS_KIND,
  answerDigestOf,
  compileDefinition,
  decodeRecords,
  definitionDigest,
  definitionToJson,
  insightsStorePathFor,
  parseWalkDefinition,
  walkRecords,
  walkSidecarPathFor,
  walkStorePathFor,
  type WalkDefinitionJson,
} from "@codegraph/insights";
import { parseInvocation } from "../src/args.js";
import { explainCommand } from "../src/commands/explain.js";
import { walkCommand } from "../src/commands/walk.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { storePathForModel } from "../src/insights-paths.js";
import { FIXTURE, explainOptions, machine, unitOf, walkOptions, type Machine } from "./walk-machine.js";

/**
 * `codegraph walk` (PLAN.md §22.5, §22.6 step 7): a definition — the default,
 * a file, the flags folded over either — run by the runner explain runs on,
 * into the walk's own store. Through the seam and the fake client: stores are
 * real SQLite files in a scratch directory, side-cars live in memory, nothing
 * touches the fixture's directory.
 */

const TASK = "Say which money amounts this code computes, and from what.";
const ADHOC_SIDECAR = walkSidecarPathFor(FIXTURE, "adhoc");
const ADHOC_STORE = walkStorePathFor(FIXTURE, "adhoc");
const BASKET = "java:com.acme.order/Basket";
const AUDITED = "edge:annotationUse>name:Audited";

/** §22.2's example, with a label, a list field and an entity instruction: a definition FILE. */
const TX: WalkDefinitionJson = {
  kind: WALK_DEFINITION_KIND,
  name: "tx-boundaries",
  version: "1",
  prompt: {
    task: { operation: "Say where the transaction starts and ends.", type: "Say which transactions this type takes part in.", module: "Say how this module bounds its transactions." },
    instructions: "Answer in English.",
    entities: [{ select: { id: BASKET }, instructions: "Basket is the cart; say which line it touches." }],
  },
  answer: {
    label: "boundary",
    fields: {
      operation: { boundary: { enum: ["starts", "joins", "none"] }, risks: "string[]" },
      type: { boundary: { enum: ["owns", "joins"], nullable: true }, notes: { list: { line: "number", text: "string" } } },
    },
  },
};
const TX_FILE = resolve("/virtual/tx.json");
const compiledOf = (json: unknown) => compileDefinition(parseWalkDefinition(json));

let machines: Machine[] = [];
afterEach(() => {
  for (const m of machines) m.cleanup();
  machines = [];
});
function newMachine(options: Parameters<typeof machine>[0] = {}): Machine {
  const m = machine(options);
  machines.push(m);
  return m;
}

/** A dry run's JSON, a run's exit — through `walkCommand` on machine `m`. */
async function walk(m: Machine, argv: readonly string[]) {
  const io = captureIo();
  const code = await walkCommand(walkOptions(argv), io, m.seam);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}
async function plan(m: Machine, argv: readonly string[]): Promise<Record<string, unknown> & { estimates: { calls: number; byStatus: Record<string, number> }; steps: { id: string; level: string; status: string }[] }> {
  const { code, stdout } = await walk(m, [...argv, "--dry-run", "--json"]);
  expect(code).toBe(EXIT.OK);
  return JSON.parse(stdout) as never;
}
async function refusal(m: Machine, argv: readonly string[]): Promise<UsageError> {
  try {
    await walkCommand(walkOptions(argv), captureIo(), m.seam);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error(`expected 'walk ${argv.join(" ")}' to be refused`);
}
const llmIds = (p: { steps: { id: string; status: string }[] }): string[] => p.steps.filter((s) => s.status === "llm").map((s) => s.id);

describe("walk --prompt: the default definition asking a task of one's own", () => {
  it("asks it of every non-trivial unit, into <model>.adhoc.walk.{db,jsonl}; a second run plans 0 calls", async () => {
    const m = newMachine();
    const before = await plan(m, ["--prompt", TASK]);
    const { code, stderr } = await walk(m, ["--prompt", TASK, "--yes"]);
    expect(code, stderr).toBe(EXIT.OK);
    // The walk's own files, and not explain's.
    expect(m.storeSha(ADHOC_STORE)).toBeDefined();
    expect(m.storeSha(storePathForModel(FIXTURE))).toBeUndefined();
    const text = m.disk.get(ADHOC_SIDECAR) ?? "";
    const compiled = compiledOf({ kind: WALK_DEFINITION_KIND, prompt: { task: TASK } });
    const header = JSON.parse(text.split("\n")[0] ?? "") as Record<string, unknown>;
    expect(header["kind"]).toBe(WALK_RECORDS_KIND);
    expect(header["walk"]).toEqual({ name: "adhoc", version: "1", digest: compiled.digest, answerDigest: answerDigestOf(compiled.answer) });
    const file = decodeRecords(walkRecords(compiled), text);
    expect(file.failures).toEqual([]);
    // One record per member asked: a cycle's members are asked together, in one call.
    const asked = before.steps.filter((s) => s.status === "llm") as unknown as { members: string[] }[];
    expect(file.records.length).toBe(asked.reduce((n, step) => n + step.members.length, 0));
    for (const record of file.records) expect(Object.keys(record.block)).toEqual(["answer", "description", "confidence"]);
    // The task, every level; explain's vocabulary nowhere; trivial members (skip, the default) never asked.
    expect(m.calls.length).toBe(before.estimates.calls);
    for (const call of m.calls) {
      expect(call.system).toContain(`## Your task\n${TASK}`);
      expect(call.system).not.toContain("Specy");
    }
    expect(before.steps.filter((s) => s.status === "template")).toEqual([]);
    expect(stderr).toMatch(/wrote \d+ records to .*model\.adhoc\.walk\.jsonl \(\d+ answered, 0 templated/u);

    const again = await plan(m, ["--prompt", TASK]);
    expect(again.estimates.calls).toBe(0);
    expect(again.estimates.byStatus["reuse"]).toBe(before.estimates.calls);
  });
});

describe("walk --walk FILE", () => {
  it("runs the file's definition under its name, its fields in every record, its entity instructions where they select", async () => {
    const m = newMachine({ files: new Map([[TX_FILE, JSON.stringify(TX)]]) });
    const { code, stderr } = await walk(m, ["--walk", TX_FILE, "--yes"]);
    expect(code, stderr).toBe(EXIT.OK);
    const text = m.disk.get(walkSidecarPathFor(FIXTURE, "tx-boundaries")) ?? "";
    expect(m.storeSha(walkStorePathFor(FIXTURE, "tx-boundaries"))).toBeDefined();
    const file = decodeRecords(walkRecords(compiledOf(TX)), text);
    const operation = file.records.find((r) => r.level === "operation");
    expect(Object.keys(operation?.block ?? {})).toEqual(["answer", "boundary", "risks", "description", "confidence"]);
    const basket = m.calls.find((call) => unitOf(call) === BASKET);
    expect(basket?.user).toContain("Instructions for this member:\n- Basket is the cart; say which line it touches.");
    expect(m.calls.every((call) => call.system.includes("## Instructions\nAnswer in English."))).toBe(true);
  });
});

describe("a flag replaces the file's key, and the effective definition is what is digested", () => {
  const BASE: WalkDefinitionJson = { ...TX, select: { kind: "method" }, levels: ["operation", "type"], closure: "none", context: { depth: 1, maxLines: 200 } };
  const prompt = BASE["prompt"] as Record<string, unknown>;
  const NOTES = resolve("/virtual/notes.md");
  const TASKFILE = resolve("/virtual/task.txt");
  const cases: readonly (readonly [string, readonly string[], WalkDefinitionJson])[] = [
    ["--name", ["--name", "other"], { ...BASE, name: "other" }],
    ["--prompt", ["--prompt", "New task."], { ...BASE, prompt: { ...prompt, task: "New task." } }],
    ["--prompt-file", ["--prompt-file", TASKFILE], { ...BASE, prompt: { ...prompt, task: "A task from a file." } }],
    ["--instructions TEXT", ["--instructions", "Be terse."], { ...BASE, prompt: { ...prompt, instructions: "Be terse." } }],
    ["--instructions @FILE", ["--instructions", `@${NOTES}`], { ...BASE, prompt: { ...prompt, instructions: "Billing uses two datasources." } }],
    ["--include", ["--include", "name:Order*"], { ...BASE, select: { name: "Order*" } }],
    ["--include twice", ["--include", "name:Order*", "--include", "id:java:com.acme.order/Money"], { ...BASE, select: { any: [{ name: "Order*" }, { id: "java:com.acme.order/Money" }] } }],
    ["--exclude", ["--exclude", "name:discount"], { ...BASE, exclude: { name: "discount" } }],
    ["--levels", ["--levels", "module,operation"], { ...BASE, levels: ["operation", "module"] }],
    ["--closure", ["--closure", "dependencies"], { ...BASE, closure: "dependencies" }],
    ["--depth", ["--depth", "2"], { ...BASE, context: { depth: 2, maxLines: 200 } }],
    ["--max-lines", ["--max-lines", "50"], { ...BASE, context: { depth: 1, maxLines: 50 } }],
  ];
  const files = new Map([
    [resolve("/virtual/base.json"), JSON.stringify(BASE)],
    [NOTES, "Billing uses two datasources.\n"],
    [TASKFILE, "A task from a file."],
  ]);

  it.each(cases)("%s: the plan and digest of the file with that key edited", async (_flag, argv, edited) => {
    const m = newMachine({ files: new Map([...files, [resolve("/virtual/edited.json"), JSON.stringify(edited)]]) });
    const viaFlag = await plan(m, ["--walk", "/virtual/base.json", ...argv]);
    const viaFile = await plan(m, ["--walk", "/virtual/edited.json"]);
    const base = await plan(m, ["--walk", "/virtual/base.json"]);
    expect(viaFlag).toEqual(viaFile);
    const compiled = compiledOf(edited);
    expect(viaFlag["walk"]).toEqual({ name: compiled.name, version: compiled.version, digest: definitionDigest(compiled.definition) });
    expect((viaFlag["walk"] as { digest: string }).digest).not.toBe((base["walk"] as { digest: string }).digest);
  });

  it("over the default definition too: --prompt alone digests as a file holding only that task", async () => {
    const m = newMachine();
    const viaFlag = await plan(m, ["--prompt", TASK]);
    expect((viaFlag["walk"] as { digest: string }).digest).toBe(definitionDigest(parseWalkDefinition({ kind: WALK_DEFINITION_KIND, prompt: { task: TASK } })));
  });
});

describe("the selection flags, and the price of what they leave out", () => {
  it("--include asks the units an entity of which matches; --exclude bars; --levels keeps a level", async () => {
    const m = newMachine();
    const audited = await plan(m, ["--prompt", TASK, "--include", AUDITED]);
    expect(llmIds(audited).sort()).toEqual(["java:com.acme.order/Order.discount(int)", "java:com.acme.order/Reporting.max(java.util.List)"]);
    const excluded = await plan(m, ["--prompt", TASK, "--include", AUDITED, "--exclude", "name:discount"]);
    expect(llmIds(excluded)).toEqual(["java:com.acme.order/Reporting.max(java.util.List)"]);
    const types = await plan(m, ["--prompt", TASK, "--levels", "type"]);
    expect(new Set(types.steps.filter((s) => s.status === "llm").map((s) => s.level))).toEqual(new Set(["type"]));
    const contained = await plan(m, ["--prompt", TASK, "--include", AUDITED, "--closure", "containers"]);
    expect(llmIds(contained).sort()).toEqual([
      "java:com.acme.order",
      "java:com.acme.order/Order",
      "java:com.acme.order/Order.discount(int)",
      "java:com.acme.order/Reporting",
      "java:com.acme.order/Reporting.max(java.util.List)",
    ]);
  });

  it("prints how many dependencies are not walked and what --closure dependencies adds: the difference the two plans show", async () => {
    const m = newMachine();
    const text = (await walk(m, ["--prompt", TASK, "--include", "id:java:com.acme.order/OrderService", "--dry-run"])).stdout;
    const notWalked = Number(/selection: (\d+) dependenc(?:y|ies) of the selection (?:is|are) not walked \(/u.exec(text)?.[1]);
    const adds = Number(/--closure dependencies adds (\d+) units? \(/u.exec(text)?.[1]);
    expect(notWalked).toBeGreaterThan(0);
    expect(adds).toBeGreaterThan(0);
    // The line sits under the statuses, before the models.
    expect(text.indexOf("  selection:")).toBeGreaterThan(text.indexOf("  statuses:"));
    expect(text.indexOf("  selection:")).toBeLessThan(text.indexOf("  models:"));
    const none = await plan(m, ["--prompt", TASK, "--include", "id:java:com.acme.order/OrderService"]);
    const deps = await plan(m, ["--prompt", TASK, "--include", "id:java:com.acme.order/OrderService", "--closure", "dependencies"]);
    // A cold store: every unit the closure adds is a unit called instead of skipped.
    expect((none.estimates.byStatus["skip-scope"] ?? 0) - (deps.estimates.byStatus["skip-scope"] ?? 0)).toBe(adds);
    expect(llmIds(deps).length - llmIds(none).length).toBe(adds);
    // The JSON carries the same price, whole; under the closure it suggests nothing more.
    const price = none["price"] as { closure: string; added: Record<string, Record<string, number>> };
    expect(price.closure).toBe("none");
    expect(Object.values(price.added["dependencies"] ?? {}).reduce((a, b) => a + b, 0)).toBe(adds);
    const after = (await walk(m, ["--prompt", TASK, "--include", "id:java:com.acme.order/OrderService", "--closure", "dependencies", "--estimate"])).stdout;
    expect(after).not.toContain("--closure dependencies adds");
  });
});

/** What a defined walk's output figure assumes, in the estimate's words (the measurement of PLAN.md §22.6 step 8). */
const MEASURED =
  `operation ${WALK_COMPLETION_TOKENS_PER_BLOCK.operation}, type ${WALK_COMPLETION_TOKENS_PER_BLOCK.type} tokens per block asked for ` +
  "(sonnet through claude-code, on a walk that declares no field: declared fields add to it; no module was measured, it takes the type's figure)";

describe("the three --json kinds", () => {
  const IDENTITY = (m: Record<string, unknown>) => expect(Object.keys(m["walk"] as object)).toEqual(["name", "version", "digest"]);

  it("codegraph.walkPlan/1, codegraph.walkEstimate/1, codegraph.walkSummary/1, each carrying walk: { name, version, digest }", async () => {
    const m = newMachine();
    const p = await plan(m, ["--prompt", TASK, "--include", AUDITED]);
    expect(Object.keys(p)).toEqual(["kind", "walk", "models", "depth", "estimates", "steps", "price"]);
    expect(p["kind"]).toBe("codegraph.walkPlan/1");
    IDENTITY(p);
    expect(Object.keys(p.steps[0] ?? {})).toEqual(["id", "level", "members", "layer", "status", "model", "calls", "promptTokens"]);

    const estimate = JSON.parse((await walk(m, ["--prompt", TASK, "--include", AUDITED, "--estimate", "--json"])).stdout) as Record<string, unknown>;
    // No `completion` key: the figure is measured, and `assumptions.completionTokens` says what it was measured on.
    expect(Object.keys(estimate)).toEqual(["kind", "walk", "models", "depth", "units", "layers", "calls", "promptTokens", "completionTokens", "byLevel", "byStatus", "assumptions", "price"]);
    expect(estimate["kind"]).toBe("codegraph.walkEstimate/1");
    IDENTITY(estimate);
    expect((estimate["assumptions"] as Record<string, string>)["completionTokens"]).toBe(`measured on a live run: ${MEASURED}`);
    expect(estimate["completionTokens"]).toBe((estimate["calls"] as number) * WALK_COMPLETION_TOKENS_PER_BLOCK.operation);

    const run = await walk(m, ["--prompt", TASK, "--include", AUDITED, "--yes", "--json"]);
    const summary = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(summary)).toEqual(["kind", "walk", "out", "counts", "usage", "failures"]);
    expect(summary["kind"]).toBe("codegraph.walkSummary/1");
    IDENTITY(summary);
    expect(summary["out"]).toBe(ADHOC_SIDECAR);
  });

  it("the estimate's text says the output figures were measured on a live run, per level, a module's being the type's", async () => {
    const text = (await walk(newMachine(), ["--prompt", TASK, "--estimate"])).stdout;
    expect(text).toMatch(/^walk estimate \(adhoc\): /mu);
    expect(text).toContain(`output ≈ measured on a live run: ${MEASURED}.`);
    expect(text).not.toMatch(/unmeasured|a guess/iu);
  });

  it("each level's output is its own measured figure per block asked for", async () => {
    const estimate = JSON.parse((await walk(newMachine(), ["--prompt", TASK, "--estimate", "--json"])).stdout) as {
      completionTokens: number;
      byLevel: Record<"operation" | "type" | "module", { calls: number; completionTokens: number }>;
    };
    let total = 0;
    for (const level of ["operation", "type", "module"] as const) {
      const { calls, completionTokens } = estimate.byLevel[level];
      expect(calls, level).toBeGreaterThan(0);
      expect(completionTokens % WALK_COMPLETION_TOKENS_PER_BLOCK[level], level).toBe(0);
      expect(completionTokens, level).toBeGreaterThanOrEqual(calls * WALK_COMPLETION_TOKENS_PER_BLOCK[level]);
      total += completionTokens;
    }
    expect(estimate.completionTokens).toBe(total);
  });

  it("--dry-run --json carries no completion key either", async () => {
    expect(Object.keys(await plan(newMachine(), ["--prompt", TASK]))).not.toContain("completion");
  });
});

describe("the walk's store and side-car round-trip", () => {
  it("--export rewrites the side-car the run wrote; --import into another store and its export are the same bytes", async () => {
    const m = newMachine();
    expect((await walk(m, ["--prompt", TASK, "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    const written = m.disk.get(ADHOC_SIDECAR) ?? "";
    m.disk.delete(ADHOC_SIDECAR);
    const exported = await walk(m, ["--prompt", TASK, "--export"]);
    expect(exported.stderr).toMatch(/^wrote 2 records to .*model\.adhoc\.walk\.jsonl from .*model\.adhoc\.walk\.db\.$/mu);
    expect(m.disk.get(ADHOC_SIDECAR)).toBe(written);

    const copy = resolve("/virtual/copy/model.adhoc.walk.jsonl");
    const imported = await walk(m, ["--prompt", TASK, "--out", copy, "--import", ADHOC_SIDECAR, "--yes"]);
    expect(imported.stderr).toMatch(/imported 2 records from .* into .*copy\/model\.adhoc\.walk\.db\./u);
    await walk(m, ["--prompt", TASK, "--out", copy, "--export"]);
    expect(m.disk.get(copy)).toBe(written);
    // The copy is the walk's: it plans what the original plans.
    expect(await plan(m, ["--prompt", TASK, "--include", AUDITED, "--out", copy])).toEqual(await plan(m, ["--prompt", TASK, "--include", AUDITED]));
  });

  it("--export and --import of a walk that has no store say whose", async () => {
    const m = newMachine();
    await expect(walkCommand(walkOptions(["--name", "risk", "--export"]), captureIo(), m.seam)).rejects.toThrow(/--export found no store of the walk "risk" at .*model\.risk\.walk\.db/u);
    await expect(walkCommand(walkOptions(["--import", "/virtual/none.jsonl"]), captureIo(), m.seam)).rejects.toThrow(/--import cannot read/u);
  });
});

describe("a changed definition is told before the count, and nothing is written before the answer", () => {
  it("another task: the confirmation names the units asked again and REPLACED; declined, the store and side-car are as they were", async () => {
    const m = newMachine({ confirm: false });
    expect((await walk(m, ["--prompt", TASK, "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    const sha = m.storeSha(ADHOC_STORE);
    const sidecar = m.disk.get(ADHOC_SIDECAR);
    const stores = m.storeFiles();
    const asked = llmIds(await plan(m, ["--prompt", "Another task.", "--include", AUDITED]));
    expect(asked).toHaveLength(2);

    const declined = await walk(m, ["--prompt", "Another task.", "--include", AUDITED]);
    expect(declined.code).toBe(EXIT.OK);
    const notice = "note: the definition changed since this store was written: these 2 units are asked again and their records REPLACED; --name OTHER keeps both.";
    expect(declined.stderr).toContain(notice);
    expect(declined.stderr.indexOf(notice)).toBeLessThan(declined.stderr.indexOf("walk estimate (adhoc):"));
    expect(declined.stderr.indexOf(notice)).toBeLessThan(declined.stderr.indexOf("  calls: 2"));
    expect(m.questions.at(-1)).toMatch(/^Run 2 model calls /u);
    expect(declined.stderr).toContain("aborted: no call was made, nothing was written.");
    expect(m.storeSha(ADHOC_STORE)).toBe(sha);
    expect(m.disk.get(ADHOC_SIDECAR)).toBe(sidecar);
    expect(m.storeFiles()).toEqual(stores);

    // The dry run says it first, on stdout; as JSON, on stderr, stdout still one document.
    const dry = await walk(m, ["--prompt", "Another task.", "--include", AUDITED, "--dry-run"]);
    expect(dry.stdout.split("\n")[0]).toBe(notice);
    const json = await walk(m, ["--prompt", "Another task.", "--include", AUDITED, "--dry-run", "--json"]);
    expect(json.stderr).toContain(notice);
    expect(() => JSON.parse(json.stdout) as unknown).not.toThrow();
    expect(m.storeSha(ADHOC_STORE)).toBe(sha);

    // Confirmed, the records are replaced and the store is the new definition's: nothing more to tell.
    const confirmedRun = await walkCommand(walkOptions(["--prompt", "Another task.", "--include", AUDITED, "--yes"]), captureIo(), m.seam);
    expect(confirmedRun).toBe(EXIT.OK);
    expect((await walk(m, ["--prompt", "Another task.", "--include", AUDITED, "--dry-run"])).stdout).not.toContain("the definition changed");
  });

  it("a change that moves no fingerprint is told as such", async () => {
    const m = newMachine();
    expect((await walk(m, ["--prompt", TASK, "--yes"])).code).toBe(EXIT.OK);
    // Everything is selected already: a closure changes the digest and asks nothing new.
    const dry = await walk(m, ["--prompt", TASK, "--closure", "dependencies", "--dry-run"]);
    expect(dry.stdout.split("\n")[0]).toBe("note: the definition changed since this store was written: no unit it holds is asked again (the change moves no fingerprint); --name OTHER keeps both.");
  });
});

describe("a store is opened only by the walk, and the answer, that wrote it", () => {
  const RISK = (fields: Record<string, unknown>) => JSON.stringify({ kind: WALK_DEFINITION_KIND, name: "risk", answer: { fields: { operation: fields } } });

  it("a changed answer is refused like another walk, bytes untouched; --name OTHER keeps both", async () => {
    const m = newMachine({ files: new Map([[resolve("/virtual/v1.json"), RISK({ risky: "boolean" })], [resolve("/virtual/v2.json"), RISK({ risk: { enum: ["low", "high"] } })]]) });
    expect((await walk(m, ["--walk", "/virtual/v1.json", "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    const store = walkStorePathFor(FIXTURE, "risk");
    const sha = m.storeSha(store);
    for (const argv of [["--yes"], ["--dry-run"], ["--estimate"], ["--export"]]) {
      const error = await refusal(m, ["--walk", "/virtual/v2.json", "--include", AUDITED, ...argv]);
      expect(error.message, argv.join(" ")).toMatch(/model\.risk\.walk\.db: this store holds the records of the walk "risk" \(codegraph\.walkRecords\/1\) under other answer fields: every unit would be asked again anyway/u);
      expect(error.hint, argv.join(" ")).toMatch(/^The answer fields changed since this store was written: .* --name OTHER keeps both/u);
      expect(m.storeSha(store)).toBe(sha);
    }
    // The side-car alone (no store beside it) is refused the same way.
    const { rmSync } = await import("node:fs");
    rmSync(m.storeFile(store));
    const sidecarOnly = await refusal(m, ["--walk", "/virtual/v2.json", "--dry-run"]);
    expect(sidecarOnly.message).toMatch(/is not a codegraph\.walkRecords\/1 side-car: line 1 is the header of the walk "risk" .* under other answer fields/u);
    expect(sidecarOnly.hint).toMatch(/^--name OTHER keeps both/u);
    // Under another name, the new answer has a store of its own.
    expect((await walk(m, ["--walk", "/virtual/v2.json", "--name", "risk-v2", "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    expect(m.storeSha(walkStorePathFor(FIXTURE, "risk-v2"))).toBeDefined();
  });

  it("another walk's store, and explain's, are refused naming both walks; nothing written", async () => {
    const m = newMachine();
    expect((await walk(m, ["--prompt", TASK, "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    const sha = m.storeSha(ADHOC_STORE);
    const other = await refusal(m, ["--name", "other", "--out", ADHOC_SIDECAR, "--dry-run"]);
    expect(other.message).toContain('this store holds the records of the walk "adhoc" (codegraph.walkRecords/1), not of the walk "other" (codegraph.walkRecords/1)');
    expect(other.hint).toMatch(/Each walk keeps its own store/u);
    expect(m.storeSha(ADHOC_STORE)).toBe(sha);

    const io = captureIo();
    expect(await explainCommand(explainOptions(["--scope", "java:com.acme.order/Reporting", "--yes"]), io, m.seam)).toBe(EXIT.OK);
    const explainSha = m.storeSha(storePathForModel(FIXTURE));
    const onExplain = await refusal(m, ["--prompt", TASK, "--out", resolve(FIXTURE, "../model.insights.jsonl"), "--dry-run"]);
    expect(onExplain.message).toContain('of the walk "explain" (codegraph.insights/1), not of the walk "adhoc" (codegraph.walkRecords/1)');
    expect(m.storeSha(storePathForModel(FIXTURE))).toBe(explainSha);
    await expect(explainCommand(explainOptions(["--out", ADHOC_SIDECAR, "--dry-run"]), captureIo(), m.seam)).rejects.toThrow(/of the walk "adhoc" \(codegraph\.walkRecords\/1\), not of the walk "explain"/u);
  });
});

describe("refusals with the path of the fault", () => {
  it("reserved and malformed names, from --name or from the file", async () => {
    const m = newMachine({ files: new Map([[resolve("/virtual/named.json"), JSON.stringify({ kind: WALK_DEFINITION_KIND, name: "explain" })]]) });
    expect((await refusal(m, ["--name", "explain"])).message).toMatch(/^the default definition with these flags is not a valid walk definition \(1 fault\):\n {2}name \(from --name\): "explain" is reserved for the built-in walk/u);
    expect((await refusal(m, ["--name", "insights"])).message).toMatch(/name \(from --name\): "insights" is reserved/u);
    expect((await refusal(m, ["--name", "Tx_1"])).message).toMatch(/name \(from --name\): must match \[a-z\]\[a-z0-9-\]\*/u);
    const fromFile = await refusal(m, ["--walk", "/virtual/named.json"]);
    expect(fromFile.message).toMatch(/^\/virtual\/named\.json is not a valid walk definition \(1 fault\):\n {2}name: "explain" is reserved .*codegraph explain --walk/u);
    expect(fromFile.hint).toContain("codegraph walk --print-definition");
  });

  it("a bad file names the file and every fault's path; an unreadable or non-JSON one says so", async () => {
    // Every fault of a pass at once; a structural fault is reported first, alone (the parser's two passes).
    const bad = { kind: WALK_DEFINITION_KIND, name: "Tx_1", answer: { fields: { operation: { risk: "int" } } }, prompt: { entities: [{ select: { kind: "klass" }, instructions: "x" }] } };
    const m = newMachine({
      files: new Map([
        [resolve("/virtual/bad.json"), JSON.stringify(bad)],
        [resolve("/virtual/shape.json"), JSON.stringify({ kind: WALK_DEFINITION_KIND, levels: ["operation", "class"] })],
        [resolve("/virtual/broken.json"), "{ not json"],
      ]),
    });
    const error = await refusal(m, ["--walk", "/virtual/bad.json"]);
    expect(error.message).toMatch(/^\/virtual\/bad\.json is not a valid walk definition \(3 faults\):/u);
    expect(error.message).toContain("  name: must match [a-z][a-z0-9-]*");
    expect(error.message).toContain('  answer.fields.operation.risk: unknown field type "int"');
    expect(error.message).toContain('  prompt.entities[0].select.kind: unknown kind "klass"');
    expect((await refusal(m, ["--walk", "/virtual/shape.json"])).message).toBe('/virtual/shape.json is not a valid walk definition (1 fault):\n  levels[1]: unknown level "class"; valid: operation, type, module');
    expect((await refusal(m, ["--walk", "/virtual/missing.json"])).message).toBe(`--walk cannot read /virtual/missing.json`);
    expect((await refusal(m, ["--walk", "/virtual/broken.json"])).message).toMatch(/^--walk \/virtual\/broken\.json is not JSON: /u);
    expect((await refusal(m, ["--prompt", " "])).message).toContain("prompt.task (from --prompt): must not be empty");
    expect((await refusal(m, ["--instructions", "Quote ````x````"])).message).toContain("prompt.instructions (from --instructions): ");
    expect((await refusal(m, ["--prompt-file", "/virtual/none.txt"])).message).toBe("--prompt-file cannot read /virtual/none.txt");
  });

  it("a bad selector term is a usage error when parsed, before any model is read", () => {
    expect(() => walkOptions(["--include", "edge:calls"])).toThrow(/^--include "edge:calls": unknown edge kind "calls"; valid: /u);
    expect(() => walkOptions(["--exclude", "klass:Order"])).toThrow(/^--exclude "klass:Order": unknown term "klass:"/u);
  });
});

describe("--print-definition", () => {
  it("prints the default definition, which parses back to itself and runs as the default", async () => {
    const io = captureIo();
    const parsed = parseInvocation(["walk", "--print-definition"]);
    if (parsed.kind !== "run" || parsed.command !== "walk") throw new Error("not a walk");
    expect(await walkCommand(parsed.options, io)).toBe(EXIT.OK);
    const json = JSON.parse(io.stdout()) as WalkDefinitionJson;
    expect(json).toEqual(DEFAULT_WALK_DEFINITION);
    expect(definitionToJson(parseWalkDefinition(json))).toEqual(json);
    const m = newMachine({ files: new Map([[resolve("/virtual/default.json"), io.stdout()]]) });
    expect(await plan(m, ["--walk", "/virtual/default.json"])).toEqual(await plan(m, []));
  });

  it("prints explain's, which explain --walk accepts as changing nothing and walk --walk refuses with paths", async () => {
    const io = captureIo();
    const parsed = parseInvocation(["walk", "--print-definition", "explain"]);
    if (parsed.kind !== "run" || parsed.command !== "walk") throw new Error("not a walk");
    expect(await walkCommand(parsed.options, io)).toBe(EXIT.OK);
    expect(JSON.parse(io.stdout())).toEqual(EXPLAIN_WALK_DEFINITION);
    const file = resolve("/virtual/explain.json");
    const m = newMachine({ files: new Map([[file, io.stdout()]]) });
    const plain = captureIo();
    const viaFile = captureIo();
    await explainCommand(explainOptions(["--dry-run", "--json"]), plain, m.seam);
    await explainCommand(explainOptions(["--walk", file, "--dry-run", "--json"]), viaFile, m.seam);
    expect(viaFile.stdout()).toBe(plain.stdout());
    const refused = await refusal(m, ["--walk", file]);
    expect(refused.message).toContain('  name: "explain" is reserved');
    expect(refused.message).toContain("  answer.builtin: ");
  });

  it("takes no model and no other flag", () => {
    expect(() => parseInvocation(["walk", "--print-definition", "other"])).toThrow(/--print-definition prints the default definition, or explain's: got 'other'/u);
    expect(() => parseInvocation(["walk", "--print-definition", "--json"])).toThrow(/--print-definition takes no other option \(got --json\)/u);
  });
});

describe("--retry-failed on a walk", () => {
  const MODULE = "java:com.acme.order";

  it("redoes the failed unit and its direct dependents; a selection flag cannot go with it", async () => {
    const refusing = newMachine({ refuse: (request) => request.user.startsWith(`# Unit: type java:com.acme.order/Reporting\n`) });
    const first = await walk(refusing, ["--prompt", TASK, "--include", AUDITED, "--closure", "containers", "--yes"]);
    expect(first.code).toBe(EXIT.FINDINGS);
    expect(first.stderr).toContain("failed: java:com.acme.order/Reporting: ");
    const sidecar = refusing.disk.get(ADHOC_SIDECAR) ?? "";
    const compiled = compiledOf({ kind: WALK_DEFINITION_KIND, prompt: { task: TASK }, select: selectorToJson(parseTerm(AUDITED)), closure: "containers" });
    expect(decodeRecords(walkRecords(compiled), sidecar).failures.map((f) => f.id)).toEqual(["java:com.acme.order/Reporting"]);

    const retry = newMachine({ files: new Map([[ADHOC_SIDECAR, sidecar]]) });
    const again = await walk(retry, ["--prompt", TASK, "--retry-failed", "--yes"]);
    expect(again.code, again.stderr).toBe(EXIT.OK);
    expect(again.stderr).toContain("retrying 1 failed unit");
    expect(retry.calls.map(unitOf).sort()).toEqual([MODULE, "java:com.acme.order/Reporting"]);
    expect(decodeRecords(walkRecords(compiled), retry.disk.get(ADHOC_SIDECAR) ?? "").failures).toEqual([]);
    for (const flag of [["--include", AUDITED], ["--exclude", "kind:method"], ["--levels", "type"], ["--closure", "all"]]) {
      expect(() => walkOptions(["--retry-failed", ...flag])).toThrow(new RegExp(`^--retry-failed and ${flag[0]} both choose what to ask`, "u"));
    }
  });
});

describe("walk --walk explain is explain", () => {
  it("--dry-run --json equals explain's but for the kind; customized alike, with the walk key", async () => {
    const m = newMachine();
    const explain = captureIo();
    await explainCommand(explainOptions(["--dry-run", "--json"]), explain, m.seam);
    const viaWalk = (await walk(m, ["--walk", "explain", "--dry-run", "--json"])).stdout;
    expect(viaWalk.replace('"kind":"codegraph.walkPlan/1"', '"kind":"codegraph.explainPlan/1"')).toBe(explain.stdout());
    expect(viaWalk).toContain('"kind":"codegraph.walkPlan/1"');

    const custom = captureIo();
    await explainCommand(explainOptions(["--instructions", "Answer in French.", "--include", AUDITED, "--dry-run", "--json"]), custom, m.seam);
    const customWalk = JSON.parse((await walk(m, ["--walk", "explain", "--instructions", "Answer in French.", "--include", AUDITED, "--dry-run", "--json"])).stdout) as Record<string, unknown>;
    // A walk's documents add who (`walk`) and the selection's price; explain's keep their shape.
    const { kind, walk: identity, price, ...rest } = customWalk;
    expect(kind).toBe("codegraph.walkPlan/1");
    expect(identity).toMatchObject({ name: "explain", version: "2" });
    expect(price).toMatchObject({ closure: "none" });
    expect({ kind: "codegraph.explainPlan/1", ...rest }).toEqual(JSON.parse(custom.stdout()));
  });

  it("writes explain's store and side-car, and takes neither a task nor a name", async () => {
    const m = newMachine();
    expect((await walk(m, ["--walk", "explain", "--include", AUDITED, "--yes"])).code).toBe(EXIT.OK);
    expect(m.storeSha(storePathForModel(FIXTURE))).toBeDefined();
    expect(m.disk.get(insightsStorePathFor(ADHOC_SIDECAR))).toBeUndefined();
    expect(() => walkOptions(["--walk", "explain", "--prompt", TASK])).toThrow(/^--prompt does not apply to --walk explain/u);
    expect(() => walkOptions(["--walk", "explain", "--name", "x"])).toThrow(/^--name does not apply to --walk explain/u);
  });
});
