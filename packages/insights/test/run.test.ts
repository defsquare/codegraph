import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildWalk } from "../src/order.js";
import { planRun, retryScope, type PlanEnv, type PlanOptions } from "../src/plan.js";
import { memoryBook, type RecordBook } from "../src/records.js";
import { executeRun, type Completer, type CompletionRequest } from "../src/run.js";
import type { Block, FailureRecord, InsightRecord, ModuleBlock, OperationBlock, TypeBlock } from "../src/schema.js";
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
function fakeCompleter(overrides: { badFirst?: Set<string>; failing?: Set<string>; throwing?: Map<string, unknown> } = {}): Completer & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const seenBad = new Set<string>();
  const completer = (async (request: CompletionRequest) => {
    requests.push(request);
    const unitId = /^# Unit: \w+ (\S+)/u.exec(request.user)?.[1] ?? "";
    const level = request.schemaName.replace(/^codegraph_/u, "").replace(/_cycle$/u, "");
    const blockFor = (id: string): Block =>
      level === "operation" ? operationBlock(id) : level === "type" ? typeBlock(id) : moduleBlock(id);
    if (overrides.throwing?.has(unitId)) throw overrides.throwing.get(unitId);
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

async function run(existing: Map<string, InsightRecord>, options: Partial<PlanOptions> = {}, completer = fakeCompleter(), concurrency = 1, previousFailures: readonly FailureRecord[] = []) {
  const { walk, env } = corpus();
  const plan = planRun(walk, existing, env, { ...OPTIONS, ...options });
  const emitted: string[] = [];
  const layers: number[] = [];
  const result = await executeRun(plan, env, existing, completer, { maxScc: 12, depth: 1, maxLines: 100, previousFailures }, {
    concurrency,
    onRecord: (r) => void emitted.push(r.id),
    onLayer: (l) => void layers.push(l),
  });
  return { plan, result, emitted, layers, completer };
}

/** A book that counts what is asked of it: `fingerprint` is free, `summary` reads (a projection of) a block. */
function spyBook(records: Iterable<InsightRecord> = []) {
  const inner = memoryBook(records);
  const gets: string[] = [];
  const puts: string[] = [];
  let alls = 0;
  const book: RecordBook = {
    fingerprint: (id) => inner.fingerprint(id),
    summary: (id) => {
      gets.push(id);
      return inner.summary(id);
    },
    size: () => inner.size(),
    put: (unitId, unit) => {
      puts.push(unitId);
      return inner.put(unitId, unit);
    },
    all: () => {
      alls += 1;
      return inner.all();
    },
  };
  return { book, gets, puts, alls: () => alls };
}

describe("lazy reads (M16b): a block is read only when a prompt quotes it", () => {
  it("a plan that reuses everything decides on fingerprints alone — not one block is read", async () => {
    const first = await run(new Map());
    const { walk, env } = corpus();
    const spy = spyBook(first.result.records);
    const plan = planRun(walk, spy.book, env, OPTIONS);
    expect(plan.estimates.byStatus.llm).toBe(0);
    expect(plan.estimates.byStatus.reuse).toBeGreaterThan(0);
    expect(spy.gets).toEqual([]);
  });

  it("a plan from a book equals the plan from the same records as a map", async () => {
    const first = await run(new Map());
    const { walk, env } = corpus();
    const records = new Map(first.result.records.map((r) => [r.id, r]));
    // Drop one leaf: its dependents are re-planned, and their prompts quote what is left.
    records.delete(m("h"));
    const fromMap = planRun(walk, records, env, OPTIONS);
    const fromBook = planRun(walk, memoryBook(records.values()), env, OPTIONS);
    expect(JSON.stringify(fromBook.steps)).toBe(JSON.stringify(fromMap.steps));
    expect(fromBook.estimates).toEqual(fromMap.estimates);
  });

  it("a run that reuses everything reads no block, commits only its templates, and keeps no record of its own", async () => {
    const first = await run(new Map());
    const { walk, env } = corpus();
    const spy = spyBook(first.result.records);
    const plan = planRun(walk, spy.book, env, OPTIONS);
    const result = await executeRun(plan, env, spy.book, fakeCompleter(), { maxScc: 12, depth: 1, maxLines: 100 }, { concurrency: 1 });
    expect(spy.gets).toEqual([]);
    expect(spy.puts).toEqual([m("getTotal")]);
    expect(result.counts.records).toBe(first.result.records.length);
    // `records` materializes every record: a convenience the CLI never touches.
    expect(spy.alls()).toBe(0);
    expect(result.records.map((r) => r.id)).toEqual(first.result.records.map((r) => r.id));
    expect(spy.alls()).toBe(1);
  });

  it("a cold run asks the book only for what its prompts quote — a unit's dependencies and parts — after they were put", async () => {
    const { walk, env } = corpus();
    const spy = spyBook();
    const plan = planRun(walk, spy.book, env, OPTIONS);
    const planGets = spy.gets.length;
    await executeRun(plan, env, spy.book, fakeCompleter(), { maxScc: 12, depth: 1, maxLines: 100 }, { concurrency: 1 });
    const asked = new Set(spy.gets.slice(planGets));
    // g quotes h, f quotes g, T quotes its operations, p quotes T. Nobody quotes the module or f's caller.
    expect([...asked].sort()).toEqual([T, m("f"), m("g"), m("getTotal"), m("h")].sort());
    expect(spy.puts).toEqual([m("getTotal"), m("h"), m("g"), m("f"), T, P]);
  });

  it("the layer hook hands over what is owed, not every record so far", async () => {
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const seen: unknown[][] = [];
    await executeRun(plan, env, new Map(), fakeCompleter(), { maxScc: 12, depth: 1, maxLines: 100 }, {
      concurrency: 1,
      onLayer: (...args) => void seen.push(args),
    });
    expect(seen.every((args) => args.length === 2 && typeof args[0] === "number" && Array.isArray(args[1]))).toBe(true);
  });
});

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
    expect(failed.result.failures.map((f) => f.id)).toEqual([m("h")]);
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

  it("a failure is a record: the unit, its entities, the model asked, the reason and what it cost", async () => {
    // What a provider error looks like from here: an Error carrying `status` and `retryable`.
    const credits = Object.assign(new Error("This request requires more credits, or fewer max_tokens."), { status: 402, retryable: false });
    const { result } = await run(new Map(), {}, fakeCompleter({ throwing: new Map([[P, credits]]), failing: new Set([m("h")]) }));
    expect(result.failures).toEqual([
      {
        t: "f",
        id: m("h"),
        level: "operation",
        members: [m("h")],
        model: "leaf-model",
        reason: { kind: "invalid-answer", message: expect.stringContaining("invalid answer after repair") as string },
        attempts: 1,
        calls: 2,
      },
      {
        t: "f",
        id: P,
        level: "module",
        members: [P],
        model: "rollup-model",
        reason: { kind: "provider", message: "This request requires more credits, or fewer max_tokens.", status: 402, retryable: false },
        attempts: 1,
        calls: 0,
      },
    ]);
  });

  it("hands the failures so far to the layer hook, so an interrupted run has already written them", async () => {
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const seen: string[][] = [];
    await executeRun(plan, env, new Map(), fakeCompleter({ failing: new Set([m("h")]) }), { maxScc: 12, depth: 1, maxLines: 100 }, {
      concurrency: 1,
      onLayer: (_layer, failures) => void seen.push(failures.map((f) => f.id)),
    });
    expect(seen[0]).toEqual([m("h")]);
    expect(seen.at(-1)).toEqual([m("h")]);
  });

  it("hands a finished UNIT over whole — every member of a cycle at once — which is what a store commits", async () => {
    const { walk, env } = corpus([edge("invocation", m("h"), m("f"))]);
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const units: { unit: string; ids: string[] }[] = [];
    const result = await executeRun(plan, env, new Map(), fakeCompleter(), { maxScc: 12, depth: 1, maxLines: 100 }, {
      concurrency: 1,
      onUnit: (records, step) => void units.push({ unit: step.unit.id, ids: records.map((r) => r.id) }),
    });
    expect(units).toContainEqual({ unit: m("f"), ids: [m("f"), m("g"), m("h")] });
    // Templates are units too; reuse and skips hand nothing over.
    expect(units.flatMap((u) => u.ids).sort()).toEqual(result.records.map((r) => r.id).sort());
  });

  it("reports a failure the moment it happens, not at the layer boundary — and never for a unit it did not attempt", async () => {
    const credits = Object.assign(new Error("no credits"), { status: 402, retryable: false });
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const events: string[] = [];
    const result = await executeRun(plan, env, new Map(), fakeCompleter({ throwing: new Map([[m("h"), credits]]) }), { maxScc: 12, depth: 1, maxLines: 100 }, {
      concurrency: 1,
      onFailure: (failure, step) => void events.push(`failed ${failure.id} in ${step.unit.id} (attempt ${failure.attempts})`),
      onLayer: (layer) => void events.push(`layer ${layer}`),
    });
    expect(events[0]).toBe(`failed ${m("h")} in ${m("h")} (attempt 1)`);
    expect(events.filter((e) => e.startsWith("failed"))).toHaveLength(1);
    expect(result.aborted?.notAttempted).toBeGreaterThan(0);
  });

  it("retryScope plans the failed units and their direct dependents, and nothing else", async () => {
    const failed = await run(new Map(), {}, fakeCompleter({ failing: new Set([m("h")]) }));
    const existing = new Map(failed.result.records.map((r) => [r.id, r]));
    const { walk, env } = corpus();
    const plan = planRun(walk, existing, env, { ...OPTIONS, inScope: retryScope(failed.result.failures, walk) });
    const status = new Map(plan.steps.map((s) => [s.unit.id, s.status]));
    expect(status.get(m("h"))).toBe("llm");
    // g was explained WITHOUT h: stale once h exists.
    expect(status.get(m("g"))).toBe("llm");
    // …and so was T, which rolls h up. Nothing further: P hashes T's plan-time fingerprint, which never moved.
    expect(status.get(T)).toBe("llm");
    expect(status.get(m("f"))).toBe("reuse");
    expect(status.get(P)).toBe("reuse");

    const retried = await run(existing, { inScope: retryScope(failed.result.failures, walk) }, fakeCompleter(), 1, failed.result.failures);
    expect(retried.completer.requests).toHaveLength(3);
    expect(retried.result.failures).toEqual([]);
    expect(retried.result.records.map((r) => r.id)).toContain(m("h"));
  });

  it("a unit that fails again counts its attempts; one that was not attempted keeps its failure", async () => {
    const first = await run(new Map(), {}, fakeCompleter({ failing: new Set([m("h")]) }));
    const existing = new Map(first.result.records.map((r) => [r.id, r]));
    const again = await run(existing, {}, fakeCompleter({ failing: new Set([m("h")]) }), 1, first.result.failures);
    expect(again.result.failures.map((f) => [f.id, f.attempts])).toEqual([[m("h"), 2]]);
    // Out of scope this time: not attempted, still without a record — the failure stands as it was.
    const scoped = await run(existing, { inScope: (u) => u.id === m("g") }, fakeCompleter(), 1, first.result.failures);
    expect(scoped.result.failures).toEqual(first.result.failures);
    expect(scoped.result.counts.failed).toBe(0);
  });

  it("a 401/402/403 aborts the run: nothing further is called, and what was not attempted is not a failure", async () => {
    const credits = Object.assign(new Error("This request requires more credits"), { status: 402, retryable: false });
    const steps: string[] = [];
    const { walk, env } = corpus();
    const plan = planRun(walk, new Map(), env, OPTIONS);
    const completer = fakeCompleter({ throwing: new Map([[m("h"), credits]]) });
    const result = await executeRun(plan, env, new Map(), completer, { maxScc: 12, depth: 1, maxLines: 100 }, {
      concurrency: 1,
      onStep: (e) => void steps.push(`${e.step.unit.id} ${e.outcome}${e.aborted === true ? " aborted" : ""}`),
    });
    expect(completer.requests).toHaveLength(1);
    expect(result.failures.map((f) => [f.id, f.reason.status])).toEqual([[m("h"), 402]]);
    expect(result.aborted).toEqual({ unit: m("h"), reason: { kind: "provider", message: "This request requires more credits", status: 402, retryable: false }, notAttempted: 4 });
    expect(result.counts).toMatchObject({ failed: 1, skipped: 4, template: 1, calls: 0 });
    // What needs no call still happens; what needed one is reported as not attempted.
    expect(result.records.map((r) => r.id)).toEqual([m("getTotal")]);
    expect(steps).toContain(`${m("g")} skipped aborted`);
    expect(steps).toContain(`${P} skipped aborted`);
  });

  it("other statuses fail their unit and the run goes on; an aborted run carries earlier failures it never reached", async () => {
    const busy = Object.assign(new Error("rate limited"), { status: 429, retryable: true });
    const ok = await run(new Map(), {}, fakeCompleter({ throwing: new Map([[m("h"), busy]]) }));
    expect(ok.result.aborted).toBeUndefined();
    expect(ok.completer.requests).toHaveLength(5);

    const first = await run(new Map(), {}, fakeCompleter({ failing: new Set([m("g")]) }));
    const denied = Object.assign(new Error("no auth"), { status: 401, retryable: false });
    const existing = new Map(first.result.records.filter((r) => r.id !== m("h")).map((r) => [r.id, r]));
    const again = await run(existing, {}, fakeCompleter({ throwing: new Map([[m("h"), denied]]) }), 1, first.result.failures);
    expect(again.result.failures.map((f) => [f.id, f.attempts])).toEqual([[m("g"), 1], [m("h"), 1]]);
  });
});
