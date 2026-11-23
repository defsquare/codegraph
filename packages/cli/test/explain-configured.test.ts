import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXPLAIN_WALK_DEFINITION, PROMPT_VERSION, WALK_DEFINITION_KIND, decodeInsights, explainWalkIdentity } from "@codegraph/insights";
import { explainCommand } from "../src/commands/explain.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { sidecarPathFor } from "../src/insights-paths.js";
import { FIXTURE, explainOptions, machine, type Machine } from "./walk-machine.js";

/**
 * `explain`, CONFIGURABLE (PLAN.md §22.5): the selection flags, `--instructions`
 * and `--walk FILE` on the built-in walk. It stays explain — its kind, its
 * store, its blocks — and with nothing to carry it is the explain of every
 * release before; customized, its header says so and the next plain run is
 * told. `--scope a,b` is `--include id:a --include id:b`.
 */

const SIDECAR = sidecarPathFor(FIXTURE);
const AUDITED = "edge:annotationUse>name:Audited";
const MODULE = "java:com.acme.order";

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

async function explain(m: Machine, argv: readonly string[]) {
  const io = captureIo();
  const code = await explainCommand(explainOptions(argv), io, m.seam);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}
type Plan = { kind: string; estimates: { calls: number; byStatus: Record<string, number> }; steps: { id: string; status: string; level: string }[] } & Record<string, unknown>;
async function plan(m: Machine, argv: readonly string[]): Promise<Plan> {
  const { code, stdout } = await explain(m, [...argv, "--dry-run", "--json"]);
  expect(code).toBe(EXIT.OK);
  return JSON.parse(stdout) as Plan;
}
async function refusal(m: Machine, argv: readonly string[]): Promise<UsageError> {
  try {
    await explainCommand(explainOptions(argv), captureIo(), m.seam);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error(`expected 'explain ${argv.join(" ")}' to be refused`);
}
const statusOf = (p: Plan): Map<string, string> => new Map(p.steps.map((s) => [s.id, s.status]));

describe("--instructions: explain customized", () => {
  it("asks every non-templated unit again on a warm store, writes the walk key, and a plain run after it is told", async () => {
    const m = newMachine();
    expect((await explain(m, ["--yes"])).code).toBe(EXIT.OK);
    const warm = await plan(m, []);
    expect(warm.estimates.calls).toBe(0);

    const custom = await plan(m, ["--instructions", "Answer in French."]);
    expect(Object.keys(custom)).toEqual(["kind", "models", "depth", "estimates", "steps"]);
    for (const [id, status] of statusOf(custom)) expect(status, id).toBe(statusOf(warm).get(id) === "template" ? "template" : "llm");
    const text = (await explain(m, ["--instructions", "Answer in French.", "--dry-run"])).stdout;
    expect(text.split("\n")[0]).toBe(`note: the definition changed since this store was written: these ${custom.estimates.byStatus["llm"]} units are asked again and their records REPLACED; --out FILE keeps both.`);

    const run = await explain(m, ["--instructions", "Answer in French.", "--yes"]);
    expect(run.code, run.stderr).toBe(EXIT.OK);
    // --yes asks nothing, and still says it, before the first unit.
    expect(run.stderr.indexOf("note: the definition changed since this store was written")).toBeGreaterThanOrEqual(0);
    expect(run.stderr.indexOf("note: the definition changed")).toBeLessThan(run.stderr.indexOf("[1/"));
    expect(m.calls.slice(-1)[0]?.system).toMatch(/\n## Instructions\nAnswer in French\.\n$/u);
    const header = JSON.parse((m.disk.get(SIDECAR) ?? "").split("\n")[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(header).slice(0, 3)).toEqual(["t", "kind", "walk"]);
    expect(header["kind"]).toBe("codegraph.insights/1");
    expect(header["walk"]).toEqual(explainWalkIdentity({ instructions: "Answer in French." }));
    expect(decodeInsights(m.disk.get(SIDECAR) ?? "").header.walk?.version).toBe(PROMPT_VERSION);

    // The plain explain after it: told, every customized unit asked again, and the key gone once it has run.
    const plain = (await explain(m, ["--dry-run"])).stdout;
    expect(plain.split("\n")[0]).toMatch(/^note: the definition changed since this store was written: these \d+ units are asked again and their records REPLACED; --out FILE keeps both\.$/u);
    expect((await explain(m, ["--yes"])).code).toBe(EXIT.OK);
    expect(JSON.parse((m.disk.get(SIDECAR) ?? "").split("\n")[0] ?? "")).not.toHaveProperty("walk");
    expect((await explain(m, ["--dry-run"])).stdout.split("\n")[0]).toMatch(/^explain plan: /u);
  });

  it("@FILE reads them; a fence in them is refused with its path", async () => {
    const notes = resolve("/virtual/context.md");
    const m = newMachine({ files: new Map([[notes, "Billing uses two datasources.\n"]]) });
    expect(await plan(m, ["--instructions", `@${notes}`])).toEqual(await plan(m, ["--instructions", "Billing uses two datasources."]));
    const fence = await refusal(m, ["--instructions", "Quote ````it````."]);
    expect(fence.message).toMatch(/^explain's customization is not a valid walk definition \(1 fault\):\n {2}prompt\.instructions \(from --instructions\): /u);
    expect((await refusal(m, ["--instructions", "@/virtual/none.md"])).message).toBe("--instructions cannot read /virtual/none.md");
  });
});

describe("explain --walk FILE", () => {
  const FILE = resolve("/virtual/explain.json");

  it("takes a selection, a context and instructions — a flag replaces its key", async () => {
    const file = { kind: WALK_DEFINITION_KIND, select: { id: "java:com.acme.order/Basket" }, levels: ["operation", "type"], context: { depth: 2 }, prompt: { instructions: "Answer in French.", entities: [{ select: { id: "java:com.acme.order/Basket" }, instructions: "Basket is the cart." }] } };
    const m = newMachine({ files: new Map([[FILE, JSON.stringify(file)]]) });
    const viaFile = await plan(m, ["--walk", FILE]);
    expect(viaFile["depth"]).toBe(2);
    const asked = viaFile.steps.filter((s) => s.status === "llm");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((s) => s.level !== "module")).toBe(true);
    // --depth, --include, --levels replace the file's keys.
    const flags = await plan(m, ["--walk", FILE, "--depth", "1", "--include", "id:java:com.acme.order/Money", "--levels", "type"]);
    expect(flags["depth"]).toBe(1);
    expect(flags.steps.filter((s) => s.status === "llm").map((s) => s.id)).toEqual(["java:com.acme.order/Money"]);
    // The run's prompts carry what the file adds; its header the identity of exactly that.
    expect((await explain(m, ["--walk", FILE, "--yes"])).code).toBe(EXIT.OK);
    const basket = m.calls.find((call) => call.user.startsWith("# Unit: type java:com.acme.order/Basket "));
    expect(basket?.user).toContain("Instructions for this member:\n- Basket is the cart.");
    expect(basket?.system).toMatch(/\n## Instructions\nAnswer in French\.\n$/u);
    expect(decodeInsights(m.disk.get(SIDECAR) ?? "").header.walk?.name).toBe("explain");
  });

  it("refuses a file that would change explain's task, answer or identity, with every path", async () => {
    const bad = { kind: WALK_DEFINITION_KIND, name: "mine", version: "9", trivial: "ask", prompt: { task: "Do something else." }, answer: { label: "x", fields: { operation: { x: "string" } } } };
    const m = newMachine({ files: new Map([[FILE, JSON.stringify(bad)], [resolve("/virtual/explain-def.json"), JSON.stringify(EXPLAIN_WALK_DEFINITION)]]) });
    const error = await refusal(m, ["--walk", FILE]);
    expect(error.message).toMatch(/^\/virtual\/explain\.json is not a valid walk definition \(6 faults\):/u);
    for (const path of ["name", "version", "trivial", "prompt.task", "answer.fields", "answer.label"]) expect(error.message).toContain(`\n  ${path}: `);
    expect(error.message).toContain("prompt.task: explain asks its own task");
    // Explain's own printed definition changes nothing.
    expect(await plan(m, ["--walk", "/virtual/explain-def.json"])).toEqual(await plan(m, []));
  });
});

describe("the selection flags on explain", () => {
  it("--include/--exclude/--levels/--closure select as a walk's do, and the text prices what they leave out", async () => {
    const m = newMachine();
    const audited = await plan(m, ["--include", AUDITED]);
    const asked = audited.steps.filter((s) => s.status === "llm").map((s) => s.id).sort();
    expect(asked).toEqual(["java:com.acme.order/Order.discount(int)", "java:com.acme.order/Reporting.max(java.util.List)"]);
    // Explain's JSON keeps its shape: no price key.
    expect(Object.keys(audited)).toEqual(["kind", "models", "depth", "estimates", "steps"]);
    const text = (await explain(m, ["--include", AUDITED, "--dry-run"])).stdout;
    expect(text).toMatch(/^ {2}selection: \d+ dependenc(y|ies) of the selection (is|are) not walked \(\d+ unselected\); without a record, shown as NOT EXPLAINED$/mu);
    expect(text).toMatch(/^ {2}--closure dependencies adds \d+ units? \(operation \d+, type \d+, module \d+\)$/mu);
    expect((await explain(m, ["--include", AUDITED, "--estimate"])).stdout).toMatch(/^ {2}calls: 2 \(template 9, reuse 0, skipped 66\)\n {2}selection: /mu);

    const excluded = await plan(m, ["--include", AUDITED, "--exclude", "name:discount"]);
    expect(excluded.steps.filter((s) => s.status === "llm").map((s) => s.id)).toEqual(["java:com.acme.order/Reporting.max(java.util.List)"]);
    const modules = await plan(m, ["--levels", "module"]);
    expect(modules.steps.filter((s) => s.status === "llm").map((s) => s.level)).toEqual(["module", "module", "module"]);
    const closed = await plan(m, ["--include", AUDITED, "--closure", "containers"]);
    expect(closed.steps.filter((s) => s.status === "llm").map((s) => s.id)).toContain(MODULE);
    // Templates are explain's whatever the selection: no call either way.
    expect(closed.estimates.byStatus["template"]).toBe(9);
  });

  it("--scope X is --include id:X, byte for byte; --scope alone prices nothing, as it never did", async () => {
    const m = newMachine();
    for (const id of [MODULE, "java:com.acme.order/OrderService", "java:com.acme.order/Basket"]) {
      const scope = await explain(m, ["--scope", id, "--dry-run", "--json"]);
      const include = await explain(m, ["--include", `id:${id}`, "--dry-run", "--json"]);
      expect(include.stdout, id).toBe(scope.stdout);
    }
    const two = await explain(m, ["--scope", `${MODULE},java:com.acme.order.legacy`, "--dry-run", "--json"]);
    expect((await explain(m, ["--include", `id:${MODULE}`, "--include", "id:java:com.acme.order.legacy", "--dry-run", "--json"])).stdout).toBe(two.stdout);
    expect((await explain(m, ["--scope", "java:com.acme.order/OrderService", "--dry-run"])).stdout).not.toContain("selection:");
    expect(() => explainOptions(["--retry-failed", "--include", AUDITED])).toThrow(/^--retry-failed and --include both choose what to explain/u);
    expect(() => explainOptions(["--levels", "operation,class"])).toThrow(/^--levels: unknown level "class"/u);
    expect(() => explainOptions(["--levels", "type,type"])).toThrow(/^--levels: "type" is listed twice/u);
    expect(() => explainOptions(["--closure", "deps"])).toThrow(/^invalid value 'deps' for --closure/u);
  });
});
