import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildWalk } from "../src/order.js";
import { planRun, type PlanEnv, type PlanOptions } from "../src/plan.js";
import { executeRun, type Completer, type CompletionRequest } from "../src/run.js";
import type { Block, InsightRecord, ModuleBlock, OperationBlock, TypeBlock } from "../src/schema.js";
import { createSourceReader, mapReader } from "../src/source.js";
import { edge, field, graphOf, method, pkg, prepared, type } from "./fixture.js";

const P = "java:p";
const T = "java:p/T";
const m = (name: string): string => `${T}.${name}()`;

const SOURCE = ["class T {", "  int total;", "  int getTotal() { return total; }", "  int f() { return g(); }", "  int g() { return h(); }", "  int h() { return 1; }", "}"].join("\n");

function corpus(extraEdges: Edge[] = []) {
  const entities: Entity[] = [
    pkg(P),
    type(T, P, { anchor: { file: "T.java", span: [1, 7] } }),
    field(`${T}.total`, T),
    method(m("getTotal"), T, { anchor: { file: "T.java", span: [3, 3] }, metrics: { sloc: 1, cyclomatic: 1 } }),
    method(m("f"), T, { anchor: { file: "T.java", span: [4, 4] } }),
    method(m("g"), T, { anchor: { file: "T.java", span: [5, 5] } }),
    method(m("h"), T, { anchor: { file: "T.java", span: [6, 6] } }),
  ];
  const edges: Edge[] = [
    edge("access", m("getTotal"), `${T}.total`, "declared", { isRead: true, isWrite: false }),
    edge("invocation", m("f"), m("g")),
    edge("invocation", m("g"), m("h")),
    ...extraEdges,
  ];
  const graph = graphOf(entities, edges);
  const { facts, units } = prepared(graph);
  const walk = buildWalk(units, graph);
  const env: PlanEnv = { graph, facts, units, reader: createSourceReader(mapReader(new Map([["T.java", SOURCE]]))), unitOf: walk.unitOf };
  return { graph, units, walk, env };
}

const OPTIONS: PlanOptions = {
  models: { leaf: "leaf-model", rollup: "rollup-model" },
  depth: 1,
  maxLines: 100,
  maxScc: 12,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
};

function operationBlock(name: string): OperationBlock {
  return { name, description: `Explains ${name}.`, safe: true, idempotent: true, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.7 };
}
function typeBlock(name: string): TypeBlock {
  return { name, description: `Type ${name}.`, concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: "total", fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.6 };
}
function moduleBlock(name: string): ModuleBlock {
  return { name, description: `Module ${name}.`, apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.5 };
}

/** Answers from the request alone: the unit id is on the first line, the member ids under "Return one entry per id". */
function fakeCompleter(overrides: { badFirst?: Set<string>; failing?: Set<string> } = {}): Completer & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const seenBad = new Set<string>();
  const completer = (async (request: CompletionRequest) => {
    requests.push(request);
    const unitId = /^# Unit: \w+ (\S+)/u.exec(request.user)?.[1] ?? "";
    const level = request.schemaName.replace(/^codegraph_/u, "").replace(/_cycle$/u, "");
    const blockFor = (id: string): Block =>
      level === "operation" ? operationBlock(id) : level === "type" ? typeBlock(id) : moduleBlock(id);
    if (overrides.failing?.has(unitId)) return { json: { nonsense: true }, model: request.model };
    if (overrides.badFirst?.has(unitId) && !seenBad.has(unitId)) {
      seenBad.add(unitId);
      return { json: { wrong: "shape" }, model: request.model, usage: { promptTokens: 5, completionTokens: 1 } };
    }
    const cycle = /Return one entry per id: (.+)\./u.exec(request.user)?.[1];
    const json = cycle === undefined ? blockFor(unitId) : { members: cycle.split(", ").map((id) => ({ id, block: blockFor(id) })) };
    return { json, model: `${request.model}-served`, usage: { promptTokens: 100, completionTokens: 20, cost: 0.001 } };
  }) as Completer & { requests: CompletionRequest[] };
  completer.requests = requests;
  return completer;
}

async function run(existing: Map<string, InsightRecord>, options: Partial<PlanOptions> = {}, completer = fakeCompleter(), concurrency = 1) {
  const { walk, env } = corpus();
  const plan = planRun(walk, existing, env, { ...OPTIONS, ...options });
  const emitted: string[] = [];
  const layers: number[] = [];
  const result = await executeRun(plan, env, existing, completer, { maxScc: 12, depth: 1, maxLines: 100 }, {
    concurrency,
    onRecord: (r) => void emitted.push(r.id),
    onLayer: (l) => void layers.push(l),
  });
  return { plan, result, emitted, layers, completer };
}

describe("planRun", () => {
  it("templates the getter, plans one call per other unit, and estimates tokens", () => {
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const status = new Map(plan.steps.map((s) => [s.unit.id, s.status]));
    expect(status.get(m("getTotal"))).toBe("template");
    expect(status.get(m("h"))).toBe("llm");
    expect(status.get(T)).toBe("llm");
    expect(status.get(P)).toBe("llm");
    expect(plan.estimates.calls).toBe(5);
    expect(plan.estimates.byStatus).toEqual({ llm: 5, template: 1, reuse: 0, "skip-scope": 0, "skip-budget": 0 });
    expect(plan.estimates.promptTokens).toBeGreaterThan(0);
    expect(plan.estimates.completionTokens).toBe(3 * 450 + 650 + 900);
    expect(plan.estimates.byLevel.operation.completionTokens).toBe(3 * 450);
    expect(plan.steps.find((s) => s.unit.id === m("getTotal"))?.completionTokens).toBe(0);
    expect(plan.steps.find((s) => s.unit.id === m("h"))?.model).toBe("leaf-model");
    expect(plan.steps.find((s) => s.unit.id === T)?.model).toBe("rollup-model");
    for (const step of plan.steps) expect(step.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("--max-calls keeps a dependency-consistent prefix of the walk", () => {
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, { ...OPTIONS, maxCalls: 2 });
    const llm = plan.steps.filter((s) => s.status === "llm").map((s) => s.unit.id);
    expect(llm).toEqual([m("h"), m("g")]);
    expect(plan.estimates.byStatus["skip-budget"]).toBe(3);
  });

  it("--scope skips units outside it unless they can be reused", () => {
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, { ...OPTIONS, inScope: (u) => u.level !== "module" });
    expect(plan.steps.find((s) => s.unit.id === P)?.status).toBe("skip-scope");
    expect(plan.steps.find((s) => s.unit.id === T)?.status).toBe("llm");
  });
});

describe("executeRun", () => {
  it("produces one record per unit member in walk order, layer hooks in order, and carries usage", async () => {
    const { result, emitted, layers, completer } = await run(new Map());
    expect(result.records.map((r) => r.id)).toEqual([m("f"), m("g"), m("getTotal"), m("h"), T, P]);
    expect(emitted.indexOf(m("h"))).toBeLessThan(emitted.indexOf(m("g")));
    expect(emitted.indexOf(m("g"))).toBeLessThan(emitted.indexOf(m("f")));
    expect(emitted.indexOf(T)).toBeGreaterThan(emitted.indexOf(m("f")));
    expect(emitted.indexOf(P)).toBeGreaterThan(emitted.indexOf(T));
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    expect(result.counts).toEqual({ records: 6, llm: 5, template: 1, reused: 0, failed: 0, skipped: 0, calls: 5 });
    expect(result.usage).toEqual({ promptTokens: 500, completionTokens: 100, cost: 0.005 });
    expect(result.failures).toEqual([]);
    const getter = result.records.find((r) => r.id === m("getTotal"));
    expect(getter?.origin).toBe("template");
    expect(getter?.model).toBeUndefined();
    expect(getter?.block.description).toBe("Getter: returns the `total` field of `T`.");
    const h = result.records.find((r) => r.id === m("h"));
    expect(h?.model).toBe("leaf-model-served");
    expect(h?.usage).toEqual({ promptTokens: 100, completionTokens: 20, cost: 0.001 });
    // The caller's prompt carried the callee's fresh explanation.
    const fPrompt = completer.requests.find((r) => r.user.startsWith(`# Unit: operation ${m("f")}`));
    expect(fPrompt?.user).toContain("Explains java:p/T.g().");
  });

  it("a second run over the same inputs makes zero calls", async () => {
    const first = await run(new Map());
    const existing = new Map(first.result.records.map((r) => [r.id, r]));
    const second = await run(existing);
    expect(second.completer.requests).toHaveLength(0);
    expect(second.plan.estimates.byStatus.reuse).toBe(5);
    expect(second.result.records).toEqual(first.result.records);
  });

  it("changing a leaf's model re-explains the leaf and its dependents only", async () => {
    const first = await run(new Map());
    const existing = new Map(first.result.records.map((r) => [r.id, r]));
    const { walk, env } = corpus();
    const plan = planRun(walk, existing, env, { ...OPTIONS, models: { leaf: "leaf-v2", rollup: "rollup-model" } });
    const status = new Map(plan.steps.map((s) => [s.unit.id, s.status]));
    expect(status.get(m("h"))).toBe("llm");
    expect(status.get(m("g"))).toBe("llm");
    expect(status.get(T)).toBe("llm");
    expect(status.get(P)).toBe("llm");
  });

  it("repairs one malformed answer, and records a failure after the second", async () => {
    const repaired = await run(new Map(), {}, fakeCompleter({ badFirst: new Set([m("h")]) }));
    expect(repaired.result.failures).toEqual([]);
    expect(repaired.result.counts.calls).toBe(6);
    const hRequests = repaired.completer.requests.filter((r) => r.user.startsWith(`# Unit: operation ${m("h")}`));
    expect(hRequests).toHaveLength(2);
    expect(hRequests[1]?.user).toContain("## Your previous answer was not valid");

    const failed = await run(new Map(), {}, fakeCompleter({ failing: new Set([m("h")]) }));
    expect(failed.result.failures.map((f) => f.unit)).toEqual([m("h")]);
    expect(failed.result.counts.failed).toBe(1);
    expect(failed.result.records.map((r) => r.id)).not.toContain(m("h"));
    // The dependent still ran, saw the gap, and said so.
    const gPrompt = failed.completer.requests.find((r) => r.user.startsWith(`# Unit: operation ${m("g")}`));
    expect(gPrompt?.user).toContain("NOT EXPLAINED");
    // …and once h exists, g's fingerprint must change: a later run redoes it.
    const okPlan = planRun(corpus().walk, new Map(failed.result.records.map((r) => [r.id, r])), corpus().env, OPTIONS);
    expect(okPlan.steps.find((s) => s.unit.id === m("g"))?.status).toBe("llm");
  });

  it("concurrency does not change the record set", async () => {
    const serial = await run(new Map(), {}, fakeCompleter(), 1);
    const parallel = await run(new Map(), {}, fakeCompleter(), 4);
    expect(JSON.stringify(parallel.result.records)).toBe(JSON.stringify(serial.result.records));
  });

  it("a cycle is one call and every member gets a record listing the cycle", async () => {
    const { walk, env } = corpus([edge("invocation", m("h"), m("f"))]);
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const completer = fakeCompleter();
    const result = await executeRun(plan, env, new Map(), completer, { maxScc: 12, depth: 1, maxLines: 100 }, { concurrency: 1 });
    const cycle = plan.steps.find((s) => s.unit.members.length === 3);
    expect(cycle?.calls).toBe(1);
    // One call, three blocks asked for: the output estimate scales with the members.
    expect(cycle?.completionTokens).toBe(3 * 450);
    for (const id of [m("f"), m("g"), m("h")]) {
      const rec = result.records.find((r) => r.id === id);
      expect(rec?.scc).toEqual([m("f"), m("g"), m("h")]);
      expect(rec?.usage?.promptTokens).toBe(33);
    }
    expect(result.counts.calls).toBe(3);
  });
});
