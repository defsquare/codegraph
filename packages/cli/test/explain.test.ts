import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import { decodeInsights, encodeInsightsToString, insightsStorePathFor, sqliteInsightsStore, type InsightRecord, type InsightsStore } from "@codegraph/insights";
import { LlmError, fakeLlmClient, type LlmClient, type LlmRequest, type Provider } from "@codegraph/llm";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { run } from "../src/main.js";
import { explainCommand, realSeam, sidecarPathFor, type ExplainSeam } from "../src/commands/explain.js";
import { parseInvocation } from "../src/args.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));
const KEY = "sk-or-v1-test";

/** The fixture's source tree, loaded once into memory so the seam never touches disk during a run. */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(resolve(path), readFileSync(path, "utf8"));
    }
  };
  walk(SRC);
  return out;
}
const SOURCES = sourceFiles();

/** Answers a valid block from the request alone, like the insights run tests. */
function answer(request: LlmRequest): unknown {
  const unitId = /^# Unit: \w+ (\S+)/u.exec(request.user)?.[1] ?? "";
  const level = request.schema.name.replace(/^codegraph_/u, "").replace(/_cycle$/u, "");
  const block = (id: string): unknown => {
    const short = id.slice(id.lastIndexOf("/") + 1);
    if (level === "operation") {
      return { name: short, description: `Explains ${short}.`, safe: false, idempotent: null, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.6 };
    }
    if (level === "type") {
      return { name: short, description: `Type ${short}.`, concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.6 };
    }
    return { name: short, description: `Module ${short}.`, apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.5 };
  };
  const cycle = /Return one entry per id: (.+)\./u.exec(request.user)?.[1];
  return cycle === undefined ? block(unitId) : { members: cycle.split(", ").map((id) => ({ id, block: block(id) })) };
}

/** The stores of a test "machine": real SQLite, in memory, surviving `close()` so a second run finds them. */
type Stores = Map<string, InsightsStore>;
let clock = 0;

/** `confirm` answers every question; `null` is a session with no terminal to ask on. */
function seamWith(
  env: Record<string, string | undefined>,
  files = new Map<string, string>(),
  confirm: boolean | null = true,
  stores: Stores = new Map(),
  wrap: (store: InsightsStore) => InsightsStore = (store) => store,
) {
  const client = fakeLlmClient({ respond: answer, usage: () => ({ promptTokens: 100, completionTokens: 20, cost: 0.0001 }) });
  const disk = new Map<string, string>([...SOURCES, ...files]);
  const mtimes = new Map<string, number>();
  const providers: Provider[] = [];
  const questions: string[] = [];
  const alive = new Set<number>();
  const seam: ExplainSeam = {
    env,
    fs: {
      exists: (path) => disk.has(resolve(path)),
      readFile: (path) => disk.get(resolve(path)),
      stat: (path) => {
        const text = disk.get(resolve(path));
        return text === undefined ? undefined : { size: text.length, mtimeMs: mtimes.get(resolve(path)) ?? 0 };
      },
      writeFileAtomic: (path, text) => {
        disk.set(resolve(path), text);
        mtimes.set(resolve(path), (clock += 1));
      },
      remove: (path) => void disk.delete(resolve(path)),
    },
    stores: {
      check: () => undefined,
      exists: (path) => stores.has(resolve(path)),
      open: (path) => {
        let store = stores.get(resolve(path));
        if (store === undefined) {
          store = sqliteInsightsStore(loadSqlite().open(":memory:"));
          stores.set(resolve(path), store);
        }
        return wrap({ ...store, close: () => undefined });
      },
    },
    pid: 1000,
    isAlive: (pid) => alive.has(pid),
    clientFor: (provider) => {
      providers.push(provider);
      return client;
    },
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    confirm:
      confirm === null
        ? undefined
        : (question) => {
            questions.push(question);
            return Promise.resolve(confirm);
          },
  };
  /** An edit made outside codegraph: new bytes, a new mtime. */
  const edit = (path: string, text: string): void => {
    disk.set(resolve(path), text);
    mtimes.set(resolve(path), (clock += 1));
  };
  return { seam, client, disk, providers, questions, stores, alive, edit };
}

const CF_ENV = { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc-1" };

function options(argv: readonly string[]) {
  const invocation = parseInvocation(["explain", FIXTURE, "--src", SRC, ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  return invocation.options;
}

const OUT = resolve("/virtual/model.insights.jsonl");
const DB = insightsStorePathFor(OUT);

describe("explain --dry-run", () => {
  it("prints the plan on stdout, needs no key, and is byte-identical across runs", async () => {
    const a = captureIo();
    const b = captureIo();
    const codeA = await explainCommand(options(["--dry-run"]), a, seamWith({}).seam);
    const codeB = await explainCommand(options(["--dry-run"]), b, seamWith({}).seam);
    expect(codeA).toBe(EXIT.OK);
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stdout()).toContain("explain plan:");
    expect(a.stdout()).toMatch(/template\s+L0 operation java:com\.acme\.order\//u);
    expect(a.stdout()).toMatch(/llm\s+L\d+ type\s+java:com\.acme\.order\/Order/u);
    expect(a.stdout()).toMatch(/llm\s+L\d+ module\s+java:com\.acme\.order\b/u);
    expect(a.files().size).toBe(0);
    expect(codeB).toBe(EXIT.OK);
  });

  it("--json prints one machine-readable plan whose operations precede their type", async () => {
    const io = captureIo();
    await explainCommand(options(["--dry-run", "--json"]), io, seamWith({}).seam);
    const plan = JSON.parse(io.stdout()) as { kind: string; steps: { id: string; level: string; layer: number }[]; estimates: { calls: number } };
    expect(plan.kind).toBe("codegraph.explainPlan/1");
    expect(plan.estimates.calls).toBeGreaterThan(0);
    const order = plan.steps.find((s) => s.id === "java:com.acme.order/Order")!;
    for (const step of plan.steps.filter((s) => s.level === "operation" && s.id.startsWith("java:com.acme.order/Order."))) {
      expect(step.layer).toBeLessThan(order.layer);
    }
  });

  it("goes through run() as the one asynchronous command", async () => {
    const io = captureIo();
    const outcome = run(["explain", FIXTURE, "--src", SRC, "--dry-run", "--json"], io);
    expect(outcome).toBeInstanceOf(Promise);
    expect(await outcome).toBe(EXIT.OK);
    expect(io.stdout()).toContain("codegraph.explainPlan/1");
  });
});

describe("explain runs the walk against the model client", () => {
  it("writes header, sorted records and eof; templated accessors carry no model; the journal is gone", async () => {
    const { seam, client, disk } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("wrote ");
    const text = disk.get(OUT);
    expect(text).toBeDefined();
    const file = decodeInsights(text!);
    expect(file.header.kind).toBe("codegraph.insights/1");
    expect(file.header.metamodel).toBe("specy.domain/3");
    expect(file.truncated).toBe(false);
    expect(file.eof?.generatedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(file.eof?.counts.failed).toBe(0);
    expect(file.records.length).toBe(file.eof?.counts.records);
    const templated = file.records.filter((r) => r.origin === "template");
    expect(templated.length).toBeGreaterThan(0);
    for (const r of templated) expect(r.model).toBeUndefined();
    const explained = file.records.filter((r) => r.origin === "llm");
    // One call per unit, but a cycle call yields one record per member.
    expect(explained.length).toBeGreaterThanOrEqual(client.calls.length - countRepairs(client.calls));
    expect(countRepairs(client.calls)).toBe(0);
    for (const r of explained) expect(r.key?.lang).toBe("java");
    expect(disk.has(`${OUT}.journal`)).toBe(false);
    // Records sort operations → types → modules, by id.
    const levels = file.records.map((r) => r.level);
    expect(levels.indexOf("type")).toBeGreaterThan(levels.lastIndexOf("operation"));
    expect(levels.indexOf("module")).toBeGreaterThan(levels.lastIndexOf("type"));
  });

  it("a second run over the same side-car makes zero calls and leaves the body unchanged", async () => {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), first.seam);
    const before = first.disk.get(OUT)!;
    const second = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, before]]));
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, second.seam);
    expect(code).toBe(EXIT.OK);
    expect(second.client.calls).toHaveLength(0);
    const body = (text: string) => text.split("\n").slice(0, -2).join("\n");
    expect(body(second.disk.get(OUT)!)).toBe(body(before));
  });

  it("resumes from a journal left by a run of an older build — merged once, then gone for good", async () => {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), first.seam);
    const records = decodeInsights(first.disk.get(OUT)!).records;
    // Pretend the run died after the operations: only their records are in the journal.
    const journal = records.filter((r: InsightRecord) => r.level === "operation").map((r) => `${JSON.stringify(r)}\n`).join("");
    const resumed = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[`${OUT}.journal`, journal]]));
    const io = captureIo();
    await explainCommand(options(["--out", OUT]), io, resumed.seam);
    expect(io.stderr()).toContain("resuming from");
    const levels = resumed.client.calls.map((c) => c.schema.name);
    expect(levels.every((n) => n !== "codegraph_operation" && n !== "codegraph_operation_cycle")).toBe(true);
    expect(levels.length).toBeGreaterThan(0);
    expect(resumed.disk.has(`${OUT}.journal`)).toBe(false);
  });

  it("--max-calls caps the calls and the rest is reported as skipped", async () => {
    const { seam, client } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT, "--max-calls", "3"]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(client.calls.length).toBeLessThanOrEqual(3);
    expect(io.stderr()).toMatch(/\d+ skipped/u);
  });
});

describe("explain records what failed, and --retry-failed redoes exactly that", () => {
  const MODULE = "java:com.acme.order";
  const CREDITS = "This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 50350.";

  /** The healthy fake, except that the unit named `unitId` (every unit, when undefined) is refused. */
  // A refusal about ONE unit (it does not fit), as opposed to CREDITS, which is about the account.
  const TOO_LONG = "This endpoint's maximum context length is 163840 tokens. However, you requested about 698701 tokens.";

  function refusing(seam: ExplainSeam, client: LlmClient, unitId: string | undefined, status = 400, message = TOO_LONG): ExplainSeam {
    const broke: LlmClient = {
      name: client.name,
      complete: (request) =>
        unitId === undefined || request.user.startsWith(`# Unit: module ${unitId}\n`)
          ? client.complete(request).then(() => Promise.reject(new LlmError(message, status, false)))
          : client.complete(request),
    };
    return { ...seam, clientFor: () => broke };
  }

  async function failedRun() {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, refusing(first.seam, first.client, MODULE));
    return { code, io, text: first.disk.get(OUT)!, calls: first.client.calls.length };
  }

  it("writes one failure record per failed unit — entity, reason, status — and says how to retry", async () => {
    const { code, io, text } = await failedRun();
    expect(code).toBe(EXIT.FINDINGS);
    const file = decodeInsights(text);
    expect(file.truncated).toBe(false);
    expect(file.eof?.counts.failed).toBe(1);
    expect(file.records.map((r) => r.id)).not.toContain(MODULE);
    expect(file.failures).toEqual([
      {
        t: "f",
        id: MODULE,
        key: { lang: "java", module: "com.acme.order", symbol: "" },
        level: "module",
        members: [MODULE],
        model: options([]).rollupModel,
        reason: { kind: "provider", message: TOO_LONG, status: 400, retryable: false },
        attempts: 1,
        calls: 0,
      },
    ]);
    expect(io.stderr()).toContain(`failed: ${MODULE}: ${TOO_LONG}`);
    expect(io.stderr()).toContain("--retry-failed");
  });

  it("--retry-failed calls the failed unit and its direct dependents only, and clears the failure", async () => {
    const { text } = await failedRun();
    const retry = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, text]]));
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT, "--retry-failed"]), io, retry.seam);
    expect(code).toBe(EXIT.OK);
    expect(io.stderr()).toContain("retrying 1 failed unit");
    const units = retry.client.calls.map((c) => /^# Unit: (\w+) (\S+)/u.exec(c.user)?.slice(1, 3).join(" "));
    expect(units).toContain(`module ${MODULE}`);
    expect(units.every((u) => u?.startsWith("module "))).toBe(true);
    const file = decodeInsights(retry.disk.get(OUT)!);
    expect(file.failures).toEqual([]);
    expect(file.eof?.counts.failed).toBe(0);
    expect(file.records.map((r) => r.id)).toContain(MODULE);
    // Everything else was carried over untouched.
    const before = new Map(decodeInsights(text).records.map((r) => [r.id, JSON.stringify(r)]));
    const called = new Set(units.map((u) => u?.split(" ")[1]));
    for (const r of file.records) if (!called.has(r.id)) expect(JSON.stringify(r)).toBe(before.get(r.id));
  });

  it("a retry that fails again keeps the record and counts the attempt", async () => {
    const { text } = await failedRun();
    const retry = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, text]]));
    const code = await explainCommand(options(["--out", OUT, "--retry-failed"]), captureIo(), refusing(retry.seam, retry.client, MODULE));
    expect(code).toBe(EXIT.FINDINGS);
    expect(decodeInsights(retry.disk.get(OUT)!).failures.map((f) => [f.id, f.attempts])).toEqual([[MODULE, 2]]);
  });

  it("a 402 on the first call aborts the run: one call, one failure, and the way to resume", async () => {
    const { seam, client, disk } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT, "--concurrency", "1"]), io, refusing(seam, client, undefined, 402, CREDITS));
    expect(code).toBe(EXIT.FINDINGS);
    expect(client.calls).toHaveLength(1);
    const file = decodeInsights(disk.get(OUT)!);
    expect(file.failures).toHaveLength(1);
    expect(file.failures[0]?.reason.status).toBe(402);
    expect(file.records.every((r) => r.origin === "template")).toBe(true);
    expect(io.stderr()).toMatch(/aborted: .* answered 402/u);
    expect(io.stderr()).toMatch(/67 units were not attempted/u);
    expect(io.stderr()).toContain("--max-tokens");
    expect(io.stderr()).not.toContain("with --retry-failed");
    // A 500 on every call is each unit's own problem: the run goes through all of them.
    const flaky = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT, "--concurrency", "1"]), captureIo(), refusing(flaky.seam, flaky.client, undefined, 500, "upstream error"));
    expect(flaky.client.calls.length).toBe(68);
  });

  it("--max-tokens caps every call; without it the provider's default stands", async () => {
    const capped = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT, "--max-tokens", "4096"]), captureIo(), capped.seam);
    expect(capped.client.calls.length).toBeGreaterThan(0);
    expect(capped.client.calls.every((c) => c.maxTokens === 4096)).toBe(true);
    const free = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), free.seam);
    expect(free.client.calls.every((c) => c.maxTokens === undefined)).toBe(true);
    expect(() => options(["--max-tokens", "0"])).toThrow(/--max-tokens/u);
  });

  it("--retry-failed with nothing to retry makes no call; without a side-car, or with --scope, it is a usage error", async () => {
    const clean = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), clean.seam);
    const again = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, clean.disk.get(OUT)!]]));
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT, "--retry-failed"]), io, again.seam)).toBe(EXIT.OK);
    expect(again.client.calls).toHaveLength(0);
    expect(io.stderr()).toContain("nothing to retry");
    await expect(explainCommand(options(["--out", OUT, "--retry-failed"]), captureIo(), seamWith({ OPENROUTER_API_KEY: KEY }).seam)).rejects.toThrow(/no side-car/u);
    expect(() => options(["--retry-failed", "--scope", MODULE])).toThrow(/--retry-failed/u);
  });
});

describe("explain works against the insights store; the side-car is its export (M16a)", () => {
  const ENV = { OPENROUTER_API_KEY: KEY };
  const body = (text: string) => text.split("\n").slice(0, -2).join("\n");

  it("a run fills the store beside the side-car, and the side-car IS the store's export", async () => {
    const { seam, disk, stores } = seamWith(ENV);
    expect(await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), seam)).toBe(EXIT.OK);
    const store = stores.get(DB)!;
    expect(store).toBeDefined();
    expect(`${[...store.export()].join("\n")}\n`).toBe(disk.get(OUT));
    expect(store.openRuns()).toEqual([]);
    expect(store.exported()).toEqual({ path: OUT, size: disk.get(OUT)!.length, mtimeMs: expect.any(Number) as number });
    expect([...disk.keys()].filter((path) => path.endsWith(".journal"))).toEqual([]);
  });

  it("a second run reads the STORE: zero calls even with the side-car deleted, which is then written again", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    const before = first.disk.get(OUT)!;
    const second = seamWith(ENV, new Map(), true, first.stores);
    expect(await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), second.seam)).toBe(EXIT.OK);
    expect(second.client.calls).toHaveLength(0);
    expect(body(second.disk.get(OUT)!)).toBe(body(before));
  });

  it("first contact: a side-car with no store beside it is imported, said so, and costs no call", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    const sidecar = first.disk.get(OUT)!;
    const fresh = seamWith(ENV, new Map([[OUT, sidecar]]));
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT, "--yes"]), io, fresh.seam)).toBe(EXIT.OK);
    expect(io.stderr()).toMatch(/imported \d+ records? from .*model\.insights\.jsonl into .*model\.insights\.db/u);
    expect(fresh.client.calls).toHaveLength(0);
    expect(fresh.stores.get(DB)!.records()).toHaveLength(decodeInsights(sidecar).records.length);
    expect(body(fresh.disk.get(OUT)!)).toBe(body(sidecar));
  });

  it("--dry-run and --estimate read a side-car without creating a store", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    for (const flag of ["--dry-run", "--estimate"]) {
      const fresh = seamWith({}, new Map([[OUT, first.disk.get(OUT)!]]));
      const io = captureIo();
      expect(await explainCommand(options(["--out", OUT, flag, "--json"]), io, fresh.seam)).toBe(EXIT.OK);
      expect((JSON.parse(io.stdout()) as { byStatus?: { llm: number }; estimates?: { byStatus: { llm: number } } })).toMatchObject(
        flag === "--estimate" ? { byStatus: { llm: 0 } } : { estimates: { byStatus: { llm: 0 } } },
      );
      expect(fresh.stores.size).toBe(0);
    }
  });

  it("a run killed mid-layer keeps what it bought AND what it lost: the next run says so, reuses both, and re-asks nothing it has", async () => {
    const MODULE = "java:com.acme.order";
    const stores: Stores = new Map();
    // The provider refuses one unit (a failure row), then the process dies on the 12th committed unit.
    let commits = 0;
    const dying = seamWith(ENV, new Map(), true, stores, (store) => ({
      ...store,
      putUnit: (run, unit, records) => {
        if ((commits += 1) === 12) throw new Error("SIGKILL");
        store.putUnit(run, unit, records);
      },
    }));
    const refuse = (request: LlmRequest): unknown => {
      if (request.user.startsWith("# Unit: operation java:com.acme.order/Order.total()")) throw new LlmError("rate limited", 429, true);
      return answer(request);
    };
    dying.seam.clientFor = () => fakeLlmClient({ respond: refuse });
    await expect(explainCommand(options(["--out", OUT, "--yes", "--concurrency", "1"]), captureIo(), dying.seam)).rejects.toThrow("SIGKILL");

    const store = stores.get(DB)!;
    expect(store.records()).toHaveLength(11);
    expect(store.openRuns()).toHaveLength(1);
    expect(dying.disk.has(OUT)).toBe(false);
    const lost = store.failures().map((f) => f.id);

    const next = seamWith(ENV, new Map(), true, stores);
    const io = captureIo();
    await explainCommand(options(["--out", OUT, "--yes"]), io, next.seam);
    expect(io.stderr()).toMatch(/interrupted.*11 records/u);
    expect(store.openRuns()).toEqual([]);
    const asked = next.client.calls.map((c) => /^# Unit: \w+ (\S+)/u.exec(c.user)?.[1]);
    const kept = new Set(store.records().filter((r) => r.origin === "llm").map((r) => r.id));
    expect(asked.length).toBeGreaterThan(0);
    // What the dead run failed on is asked again; nothing it committed is.
    for (const id of lost) expect(asked).toContain(id);
    expect(decodeInsights(next.disk.get(OUT)!).truncated).toBe(false);
    expect(kept.has(MODULE)).toBe(true);
  });

  it("refuses to write beside a LIVE run, and says whose", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    const store = first.stores.get(DB)!;
    store.beginRun({ header: store.header()!, startedAt: "2026-09-19T08:00:00.000Z", pid: 4242 });
    const second = seamWith(ENV, new Map(), true, first.stores);
    second.alive.add(4242);
    await expect(explainCommand(options(["--out", OUT, "--yes", "--force"]), captureIo(), second.seam)).rejects.toThrow(/pid 4242/u);
    expect(second.client.calls).toHaveLength(0);
  });

  it("a side-car edited outside is noticed, never obeyed: the store wins until --import", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    const original = first.disk.get(OUT)!;
    const file = decodeInsights(original);
    const fewer = encodeInsightsToString(file.header, file.records.slice(1), { ...file.eof!, counts: { ...file.eof!.counts, records: file.records.length - 1 } });

    const second = seamWith(ENV, new Map([[OUT, original]]), true, first.stores);
    second.edit(OUT, fewer);
    const io = captureIo();
    await explainCommand(options(["--out", OUT, "--yes"]), io, second.seam);
    expect(io.stderr()).toMatch(/changed outside codegraph.*--import/su);
    expect(second.client.calls).toHaveLength(0);
    expect(body(second.disk.get(OUT)!)).toBe(body(original));
  });

  it("--import replaces the store with a side-car — asked first when there is something to lose; --export writes it back", async () => {
    const first = seamWith(ENV);
    await explainCommand(options(["--out", OUT, "--yes"]), captureIo(), first.seam);
    const file = decodeInsights(first.disk.get(OUT)!);
    const fewer = encodeInsightsToString(file.header, file.records.slice(1), { ...file.eof!, counts: { ...file.eof!.counts, records: file.records.length - 1 } });
    const EDITED = resolve("/virtual/edited.jsonl");

    const declined = seamWith({}, new Map([[EDITED, fewer]]), false, first.stores);
    const no = captureIo();
    expect(await explainCommand(options(["--out", OUT, "--import", EDITED]), no, declined.seam)).toBe(EXIT.OK);
    expect(declined.questions[0]).toMatch(/replace/iu);
    expect(first.stores.get(DB)!.records()).toHaveLength(file.records.length);

    const scripted = seamWith({}, new Map([[EDITED, fewer]]), null, first.stores);
    await expect(explainCommand(options(["--out", OUT, "--import", EDITED]), captureIo(), scripted.seam)).rejects.toThrow(/no terminal to confirm on/u);

    const accepted = seamWith({}, new Map([[EDITED, fewer]]), null, first.stores);
    expect(await explainCommand(options(["--out", OUT, "--import", EDITED, "--yes"]), captureIo(), accepted.seam)).toBe(EXIT.OK);
    expect(first.stores.get(DB)!.records()).toHaveLength(file.records.length - 1);

    const exporting = seamWith({}, new Map(), null, first.stores);
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT, "--export"]), io, exporting.seam)).toBe(EXIT.OK);
    expect(exporting.disk.get(OUT)).toBe(fewer);
    expect(io.stderr()).toMatch(/wrote \d+ records/u);
    expect(exporting.client.calls).toHaveLength(0);
  });

  it("--export with no store, and --import of a file that is no side-car, are usage errors", async () => {
    const empty = seamWith({});
    await expect(explainCommand(options(["--out", OUT, "--export"]), captureIo(), empty.seam)).rejects.toThrow(/no insights store/u);
    const junk = seamWith({}, new Map([[resolve("/virtual/junk.jsonl"), "{}\n"]]));
    await expect(explainCommand(options(["--out", OUT, "--import", "/virtual/junk.jsonl"]), captureIo(), junk.seam)).rejects.toThrow(/not a codegraph\.insights\/1 side-car/u);
    expect(junk.stores.size).toBe(0);
  });

  it("on a real disk: one .db and one .jsonl beside each other, nothing else, and a second run that trusts its own export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explain-store-"));
    try {
      const out = join(dir, "model.insights.jsonl");
      const runOnDisk = async () => {
        const client = fakeLlmClient({ respond: answer });
        const io = captureIo();
        const code = await explainCommand(options(["--out", out, "--yes"]), io, { ...realSeam(), env: ENV, clientFor: () => client });
        return { code, calls: client.calls.length, stderr: io.stderr() };
      };
      const first = await runOnDisk();
      expect(first.code).toBe(EXIT.OK);
      expect(first.calls).toBeGreaterThan(0);
      expect(readdirSync(dir).sort()).toEqual(["model.insights.db", "model.insights.jsonl"]);
      const second = await runOnDisk();
      expect(second.calls).toBe(0);
      expect(second.stderr).not.toContain("changed outside");
      expect(readdirSync(dir).sort()).toEqual(["model.insights.db", "model.insights.jsonl"]);
      // The file on disk is the store's export, byte for byte.
      const store = sqliteInsightsStore(loadSqlite().open(join(dir, "model.insights.db")));
      expect(`${[...store.export()].join("\n")}\n`).toBe(readFileSync(out, "utf8"));
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a runtime with no SQLite is told before anything is priced or asked", async () => {
    const { seam, client, questions } = seamWith(ENV);
    seam.stores.check = () => {
      throw new Error("SQLite is unavailable in this runtime");
    };
    await expect(explainCommand(options(["--out", OUT]), captureIo(), seam)).rejects.toThrow(/needs SQLite/u);
    expect(client.calls).toHaveLength(0);
    expect(questions).toEqual([]);
  });
});

describe("explain --estimate", () => {
  it("reports input and output token volume per level on stdout, needs no key, and is byte-identical across runs", async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await explainCommand(options(["--estimate"]), a, seamWith({}).seam)).toBe(EXIT.OK);
    expect(await explainCommand(options(["--estimate"]), b, seamWith({}).seam)).toBe(EXIT.OK);
    expect(a.stdout()).toBe(b.stdout());
    const text = a.stdout();
    expect(text).toContain("explain estimate:");
    expect(text).toMatch(/units: 77 \(operation 57, type 17, module 3\) in \d+ layers/u);
    expect(text).toMatch(/calls: 68 \(template 9, reuse 0, skipped 0\)/u);
    expect(text).toMatch(/operation\s+48\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/type\s+17\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/module\s+3\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/total\s+68\s+[\d ]+\s+[\d ]+/u);
    expect(text).toContain("cost: pass --price-in USD --price-out USD");
    expect(a.files().size).toBe(0);
  });

  it("prices the volume when both prices are given, in text and JSON", async () => {
    const io = captureIo();
    await explainCommand(options(["--estimate", "--price-in", "0.10", "--price-out", "0.60"]), io, seamWith({}).seam);
    expect(io.stdout()).toMatch(/cost at \$0\.1\/M in, \$0\.6\/M out: \$\d+\.\d{4}/u);
    const json = captureIo();
    await explainCommand(options(["--estimate", "--json", "--price-in", "0.10", "--price-out", "0.60"]), json, seamWith({}).seam);
    const report = JSON.parse(json.stdout()) as { kind: string; calls: number; promptTokens: number; completionTokens: number; cost: number; byLevel: Record<string, { completionTokens: number }> };
    expect(report.kind).toBe("codegraph.explainEstimate/1");
    expect(report.calls).toBe(68);
    // Output = one measured block average per block asked for: a cycle call asks for several.
    const per = { operation: 450, type: 650, module: 900 } as const;
    const calls = { operation: 48, type: 17, module: 3 } as const;
    let sum = 0;
    for (const level of ["operation", "type", "module"] as const) {
      const tokens = report.byLevel[level]?.completionTokens ?? 0;
      expect(tokens % per[level]).toBe(0);
      expect(tokens).toBeGreaterThanOrEqual(calls[level] * per[level]);
      sum += tokens;
    }
    expect(report.completionTokens).toBe(sum);
    expect(report.promptTokens).toBeGreaterThan(report.completionTokens);
    expect(report.cost).toBeCloseTo((report.promptTokens * 0.1 + report.completionTokens * 0.6) / 1_000_000, 10);
  });

  it("goes through run() and rejects a malformed price at parse time", async () => {
    const io = captureIo();
    expect(await run(["explain", FIXTURE, "--src", SRC, "--estimate", "--json"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("codegraph.explainEstimate/1");
    expect(() => parseInvocation(["explain", FIXTURE, "--estimate", "--price-in", "cheap"])).toThrow(/--price-in must be a non-negative USD amount/u);
    expect(() => parseInvocation(["explain", FIXTURE, "--estimate", "--price-out=-1"])).toThrow(/--price-out must be/u);
  });
});

describe("explain confirms before spending", () => {
  it("prints the token estimate on stderr and asks once before the first call", async () => {
    const { seam, client, questions } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT, "--price-in", "0.10", "--price-out", "0.60"]), io, seam)).toBe(EXIT.OK);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/^Run 68 model calls \(~[\d ]+ input \+ ~[\d ]+ output tokens, ~\$\d+\.\d{4}\)\? \[y\/N\] $/u);
    expect(io.stderr()).toMatch(/explain estimate:[\s\S]*total\s+68\s+[\d ]+\s+[\d ]+[\s\S]*wrote /u);
    expect(io.stdout()).toBe("");
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("a declined run makes no call and writes nothing", async () => {
    const { seam, client, disk } = seamWith({ OPENROUTER_API_KEY: KEY }, new Map(), false);
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT]), io, seam)).toBe(EXIT.OK);
    expect(client.calls).toHaveLength(0);
    expect(disk.has(OUT)).toBe(false);
    expect(disk.has(`${OUT}.journal`)).toBe(false);
    expect(io.stderr()).toContain("aborted: no call was made");
  });

  it("--yes runs without asking, and without a terminal", async () => {
    const { seam, client, questions } = seamWith({ OPENROUTER_API_KEY: KEY }, new Map(), null);
    const io = captureIo();
    expect(await explainCommand(options(["--out", OUT, "-y"]), io, seam)).toBe(EXIT.OK);
    expect(questions).toHaveLength(0);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(io.stderr()).not.toContain("explain estimate:");
  });

  it("with no terminal and no --yes, refuses with a usage error before any call", async () => {
    const { seam, client, disk } = seamWith({ OPENROUTER_API_KEY: KEY }, new Map(), null);
    await expect(explainCommand(options(["--out", OUT]), captureIo(), seam)).rejects.toThrow(/this run needs 68 model calls .* no terminal to confirm on/u);
    expect(client.calls).toHaveLength(0);
    expect(disk.has(OUT)).toBe(false);
  });

  it("a run that plans no call does not ask", async () => {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), first.seam);
    const second = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, first.disk.get(OUT)!]]), null);
    expect(await explainCommand(options(["--out", OUT]), captureIo(), second.seam)).toBe(EXIT.OK);
    expect(second.questions).toHaveLength(0);
  });
});

describe("explain picks its provider from the flag or the environment", () => {
  it("auto routes through Cloudflare AI Gateway when only its variables are set, and records it in the header", async () => {
    const { seam, providers, disk } = seamWith(CF_ENV);
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(new Set(providers)).toEqual(new Set(["cloudflare"]));
    expect(io.stderr()).toContain("provider: fake (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set)");
    expect(decodeInsights(disk.get(OUT)!).header.provider).toBe("cloudflare");
  });

  it("auto keeps OpenRouter when both are configured; --provider cloudflare overrides", async () => {
    const both = { OPENROUTER_API_KEY: KEY, ...CF_ENV };
    const a = seamWith(both);
    await explainCommand(options(["--out", OUT]), captureIo(), a.seam);
    expect(new Set(a.providers)).toEqual(new Set(["openrouter"]));
    const b = seamWith(both);
    const io = captureIo();
    await explainCommand(options(["--out", OUT, "--provider", "cloudflare"]), io, b.seam);
    expect(new Set(b.providers)).toEqual(new Set(["cloudflare"]));
    expect(io.stderr()).toContain("--provider cloudflare");
  });

  it("--provider cloudflare without its variables is a usage error naming them", async () => {
    const io = captureIo();
    await expect(explainCommand(options(["--out", OUT, "--provider", "cloudflare"]), io, seamWith({ OPENROUTER_API_KEY: KEY }).seam)).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set/u,
    );
    expect(io.stdout()).toBe("");
  });

  it("rejects an unknown provider at parse time", () => {
    expect(() => parseInvocation(["explain", FIXTURE, "--provider", "azure"])).toThrow(/invalid value 'azure' for --provider/u);
    expect(options([]).provider).toBe("auto");
  });
});

describe("explain usage errors exit 2 with nothing on stdout", () => {
  it("without an API key when calls are planned", async () => {
    const io = captureIo();
    const code = await run(["explain", FIXTURE, "--src", SRC, "--out", OUT], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("OPENROUTER_API_KEY");
    expect(io.stderr()).toContain("CLOUDFLARE_API_TOKEN");
  }, 20_000);

  it("with --src and two models", () => {
    expect(() => parseInvocation(["explain", FIXTURE, FIXTURE, "--src", SRC])).toThrow(/--src applies to one model/u);
  });

  it("with a source root that does not hold the anchored files", async () => {
    const io = captureIo();
    const code = await explainCommand(options(["--dry-run"]), io, seamWith({}, new Map()).seam);
    expect(code).toBe(EXIT.OK); // the fixture sources are on the fake disk
    const wrong = captureIo();
    const invocation = parseInvocation(["explain", FIXTURE, "--src", "/nowhere", "--dry-run"]);
    if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("unreachable");
    await expect(explainCommand(invocation.options, wrong, seamWith({}).seam)).rejects.toThrow(/does not contain/u);
  });

  it("with a --scope id the model does not declare", async () => {
    const io = captureIo();
    await expect(explainCommand(options(["--dry-run", "--scope", "java:nope/Nothing"]), io, seamWith({}).seam)).rejects.toThrow(/--scope names an id/u);
  });
});

describe("sidecarPathFor", () => {
  it("replaces .jsonl and appends otherwise", () => {
    expect(sidecarPathFor("out/model.jsonl")).toBe("out/model.insights.jsonl");
    expect(sidecarPathFor("model.db")).toBe("model.db.insights.jsonl");
  });
});

describe("the CLI stays off the provider SDK", () => {
  it("imports @codegraph/llm, never the SDK", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".ts")) files.push(path);
      }
    };
    walk(src);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("@openrouter" + "/sdk")).map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });
});

function countRepairs(calls: readonly LlmRequest[]): number {
  return calls.filter((c) => c.user.includes("## Your previous answer was not valid")).length;
}
