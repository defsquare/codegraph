import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildDomainFacts, identityView, internalOnly, parseTerm, type CodeGraph, type Selector, type View } from "@codegraph/analyzer";
import { buildWalk, type Unit } from "../src/order.js";
import { planRun, type PlanEnv, type PlanOptions, type RunPlan } from "../src/plan.js";
import {
  CLOSURES,
  UNFILTERED_SELECTION,
  priceSelection,
  resolveSelection,
  type Closure,
  type ResolvedSelection,
  type Selection,
  type SelectionEnv,
} from "../src/selection.js";
import type { Level } from "../src/schema.js";
import { createSourceReader, mapReader } from "../src/source.js";
import type { WalkSpec } from "../src/spec.js";
import { collectUnits } from "../src/units.js";
import { EXPLAIN, edge, graphOf, javaGraph, method, pkg, toySpeller, type } from "./fixture.js";

/**
 * THE SELECTION, HAND-CHECKED (PLAN.md §22.3, §22.6 step 4): rules 1–5 on the
 * Java fixture's known shapes — `com.acme.order` and its sub-packages,
 * `Basket` and the types nested in it, the `Basket`/`Basket.Cursor` cycle — and
 * on toy graphs built to isolate one decision each. The properties over
 * generated selections are in selection-properties.test.ts.
 */

const ORDER = "java:com.acme.order";
const ADAPTER = "java:com.acme.order.adapter";
const LEGACY = "java:com.acme.order.legacy";
const BASKET = `${ORDER}/Basket`;
const CURSOR = `${ORDER}/Basket.Cursor`;
const LINE = `${ORDER}/Basket.Line`;
const DISCOUNT = `${ORDER}/Basket.Line.Discount`;

const OPTIONS: PlanOptions = {
  models: { leaf: "leaf-model", rollup: "rollup-model" },
  depth: 1,
  maxLines: 200,
  maxScc: 12,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
  terms: 60,
};

const id = (value: string): Selector => ({ type: "id", id: value });
const select = (partial: Partial<Selection>): Selection => ({ ...UNFILTERED_SELECTION, ...partial });

interface Env extends SelectionEnv {
  readonly plan: PlanEnv;
}

function envOf(graph: CodeGraph, view: View = identityView, spec: WalkSpec = EXPLAIN): Env {
  const facts = buildDomainFacts(graph, { view });
  const units = collectUnits(graph, facts);
  const walk = buildWalk(units, graph, view);
  const plan: PlanEnv = { graph, facts, units, reader: createSourceReader(mapReader(new Map())), unitOf: walk.unitOf, speller: toySpeller(graph), spec };
  return { graph, view, units, walk, spec, plan };
}

const JAVA = envOf(javaGraph());

function resolve(env: Env, selection: Selection): ResolvedSelection {
  return resolveSelection(selection, env);
}

/** The unit ids a selection walks under its own closure, sorted. */
function walkedIds(env: Env, selection: Selection): string[] {
  const resolved = resolve(env, selection);
  return env.walk.units.filter(resolved.inScope).map((unit) => unit.id).sort();
}

function plan(env: Env, selection: Selection | undefined): RunPlan {
  return planRun(env.walk, new Map(), env.plan, { ...OPTIONS, inScope: selection === undefined ? undefined : resolve(env, selection).inScope });
}

const statusOf = (p: RunPlan): Map<string, string> => new Map(p.steps.map((step) => [step.unit.id, step.status]));

const unit = (env: Env, member: string): Unit => {
  const found = env.walk.unitOf.get(member);
  if (found === undefined) throw new Error(`no unit carries ${member}`);
  return found;
};

describe("rule 1 — downward to the NEAREST containers, on the Java fixture", () => {
  it("a module selects its own types' members, not a sub-package's", () => {
    const walked = new Set(walkedIds(JAVA, select({ include: [id(ORDER)] })));
    const left = JAVA.walk.units.filter((u) => !walked.has(u.id)).map((u) => u.id).sort();
    expect(left).toEqual([
      ADAPTER,
      `${ADAPTER}/LedgerAdapter`,
      `${ADAPTER}/LedgerAdapter.<init>()`,
      `${ADAPTER}/LedgerAdapter.post(java.lang.Object)`,
      LEGACY,
      `${LEGACY}/List`,
      `${LEGACY}/List.<init>(java.lang.String,com.acme.order.legacy.List)`,
      `${LEGACY}/List.head()`,
      `${LEGACY}/List.length()`,
    ]);
    // Two of the nine are templated by explain, so the plan leaves SEVEN skip-scope — step 1's golden figure.
    const statuses = statusOf(plan(JAVA, select({ include: [id(ORDER)] })));
    expect(left.filter((u) => statuses.get(u) === "skip-scope")).toHaveLength(7);
    expect(left.filter((u) => statuses.get(u) === "template").sort()).toEqual([`${LEGACY}/List.<init>(java.lang.String,com.acme.order.legacy.List)`, `${LEGACY}/List.head()`]);
  });

  it("a sub-tree is a glob: module:com.acme.order** reaches the sub-packages, module:com.acme.order* does not", () => {
    expect(walkedIds(JAVA, select({ include: [parseTerm("module:com.acme.order**")] }))).toEqual(JAVA.walk.units.map((u) => u.id).sort());
    expect(walkedIds(JAVA, select({ include: [parseTerm("module:com.acme.order*")] }))).toEqual(walkedIds(JAVA, select({ include: [id(ORDER)] })));
  });

  it("a type selects its own operations and its cycle, not a nested type's members", () => {
    expect(unit(JAVA, CURSOR).id).toBe(BASKET); // Basket and Basket.Cursor are one cycle
    expect(walkedIds(JAVA, select({ include: [id(BASKET)] }))).toEqual(
      [`${BASKET}.<init>()`, `${BASKET}.add(com.acme.order.Basket.Line)`, `${BASKET}.cursor()`, `${BASKET}.total()`, BASKET].sort(),
    );
    // Basket.Line is nested in Basket: its nearest type is itself, so Basket does not reach it.
    expect(walkedIds(JAVA, select({ include: [id(LINE)] }))).toEqual([LINE, `${LINE}.<init>(long)`, `${LINE}.amount()`].sort());
    expect(walkedIds(JAVA, select({ include: [id(DISCOUNT)] }))).toEqual([DISCOUNT, `${DISCOUNT}.<init>()`, `${DISCOUNT}.applyTo(long)`].sort());
  });

  it("an operation selects itself alone", () => {
    const bill = `${ORDER}/OrderService.bill(com.acme.order.Order)`;
    expect(walkedIds(JAVA, select({ include: [id(bill)] }))).toEqual([bill]);
  });

  it("selects(id) is the rule on any entity, unit or not; an id the model lacks matches nothing", () => {
    const resolved = resolve(JAVA, select({ include: [id(BASKET)] }));
    expect(resolved.selects(BASKET)).toBe(true);
    expect(resolved.selects(`${BASKET}.total()`)).toBe(true);
    expect(resolved.selects(`${CURSOR}.next()`)).toBe(false);
    expect(resolved.selects(LINE)).toBe(false);
    expect(resolved.selects(ORDER)).toBe(false);
    expect(resolve(JAVA, select({ include: [id("java:nope/Nothing")] })).inScope(unit(JAVA, BASKET))).toBe(false);
  });
});

describe("rule 3 — a cycle is one unit", () => {
  it("one selected member selects the whole cycle; its other members' own members are not reached", () => {
    const walked = walkedIds(JAVA, select({ include: [id(CURSOR)] }));
    expect(walked).toEqual([BASKET, `${CURSOR}.<init>()`, `${CURSOR}.next()`].sort());
  });

  it("an exclude that hits ONE member keeps the whole cycle unasked; the rest of the scope stays", () => {
    const resolved = resolve(JAVA, select({ include: [id(ORDER)], exclude: [id(CURSOR)] }));
    expect(resolved.standing(unit(JAVA, BASKET))).toBe("excluded");
    expect(resolved.inScope(unit(JAVA, BASKET))).toBe(false);
    expect(resolved.inScope(unit(JAVA, `${CURSOR}.next()`))).toBe(false); // nearest type Cursor: excluded
    expect(resolved.inScope(unit(JAVA, `${BASKET}.add(com.acme.order.Basket.Line)`))).toBe(true); // nearest type Basket: not excluded
    expect(resolved.inScope(unit(JAVA, ORDER))).toBe(true);
  });
});

describe("rule 1's exclude, and rule 2", () => {
  it("exclude wins over an include of the same entity, and over an include of its container", () => {
    expect(walkedIds(JAVA, select({ include: [id(BASKET)], exclude: [id(BASKET)] }))).toEqual([]);
    const resolved = resolve(JAVA, select({ include: [id(ORDER)], exclude: [id(LINE)] }));
    expect(resolved.inScope(unit(JAVA, `${LINE}.amount()`))).toBe(false);
    expect(resolved.inScope(unit(JAVA, LINE))).toBe(false);
    expect(resolved.inScope(unit(JAVA, `${DISCOUNT}.applyTo(long)`))).toBe(true); // nested in Line: Line is not its nearest type
  });

  it("levels: only the listed levels are asked", () => {
    const types = walkedIds(JAVA, select({ include: [id(ORDER)], levels: ["type"] }));
    expect(types.length).toBeGreaterThan(5);
    for (const u of types) expect(unit(JAVA, u).level).toBe("type");
    expect(walkedIds(JAVA, select({ levels: [] }))).toEqual([]);
  });
});

describe("rule 5 — not selected is skip-scope, nothing new", () => {
  it("the unfiltered selection reproduces the plan with no predicate, byte for byte", () => {
    expect(JSON.stringify(plan(JAVA, UNFILTERED_SELECTION))).toBe(JSON.stringify(plan(JAVA, undefined)));
  });

  it("a filtered plan uses only the existing statuses, and moves only the fingerprints downstream of a skipped unit", () => {
    const filtered = plan(JAVA, select({ include: [id(ORDER)] }));
    const unfiltered = plan(JAVA, undefined);
    expect(new Set(filtered.steps.map((s) => s.status))).toEqual(new Set(["llm", "template", "skip-scope"]));
    const skipped = new Set(filtered.steps.filter((s) => s.status === "skip-scope").map((s) => s.unit.id));
    // The module imports one of the skipped sub-packages' types or modules: its fingerprint names them as missing.
    const moved = filtered.steps.filter((s, i) => s.fingerprint !== unfiltered.steps[i]?.fingerprint).map((s) => s.unit.id);
    expect(moved.length).toBeGreaterThan(0);
    for (const u of moved) expect(skipped.has(u) || dependsOnAny(JAVA, u, skipped), u).toBe(true);
  });
});

function dependsOnAny(env: Env, unitId: string, targets: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const stack = [...unit(env, unitId).deps];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (targets.has(next)) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...unit(env, next).deps);
  }
  return false;
}

/**
 * A toy corpus for closure: package p holds A (f → B.g), B (g → C.h), C (h),
 * and A.N nested in A (m); package p.sub, a CHILD of p, holds S (s → A.f).
 */
function closureCorpus(): Env {
  const P = "java:p";
  const SUB = "java:p.sub";
  const entities: Entity[] = [
    pkg(P),
    pkg(SUB, false, P),
    type(`${P}/A`, P),
    type(`${P}/B`, P),
    type(`${P}/C`, P),
    type(`${P}/A.N`, `${P}/A`),
    type(`${SUB}/S`, SUB),
    method(`${P}/A.f()`, `${P}/A`),
    method(`${P}/B.g()`, `${P}/B`),
    method(`${P}/C.h()`, `${P}/C`),
    method(`${P}/A.N.m()`, `${P}/A.N`),
    method(`${SUB}/S.s()`, `${SUB}/S`),
  ];
  const edges: Edge[] = [
    edge("invocation", `${P}/A.f()`, `${P}/B.g()`),
    edge("invocation", `${P}/B.g()`, `${P}/C.h()`),
    edge("invocation", `${SUB}/S.s()`, `${P}/A.f()`),
    edge("reference", `${P}/A`, `${P}/B`),
    edge("reference", `${P}/B`, `${P}/C`),
    edge("reference", `${SUB}/S`, `${P}/A`),
    edge("import", SUB, P),
  ];
  return envOf(graphOf(entities, edges));
}

describe("rule 4 — closure, on a toy built for it", () => {
  const TOY = closureCorpus();
  const f = "java:p/A.f()";
  const walked = (partial: Partial<Selection>): string[] => walkedIds(TOY, select(partial));

  it("none: the selection alone", () => {
    expect(walked({ include: [id(f)] })).toEqual([f]);
  });

  it("dependencies: the transitive dependencies, through what may be asked", () => {
    expect(walked({ include: [id(f)], closure: "dependencies" })).toEqual(["java:p/B.g()", "java:p/C.h()", f].sort());
    // An excluded unit is never pulled back in, and closure does not walk THROUGH it: h's only
    // route to f is g, NOT EXPLAINED, so no asked prompt would ever quote h.
    expect(walked({ include: [id(f)], exclude: [id("java:p/B")], closure: "dependencies" })).toEqual([f]);
  });

  it("dependencies respects levels: a type's operations are not added when operations are not asked", () => {
    expect(walked({ include: [id("java:p/A")], levels: ["type"], closure: "dependencies" })).toEqual(["java:p/A", "java:p/A.N", "java:p/B", "java:p/C"]);
    expect(walked({ include: [id("java:p/A")], levels: ["type"], closure: "none" })).toEqual(["java:p/A"]);
  });

  it("containers: the type and module above, through a nested type; never a parent package", () => {
    expect(walked({ include: [id("java:p/A.N.m()")], closure: "containers" })).toEqual(["java:p", "java:p/A", "java:p/A.N", "java:p/A.N.m()"]);
    expect(walked({ include: [id("java:p.sub/S.s()")], closure: "containers" })).toEqual(["java:p.sub", "java:p.sub/S", "java:p.sub/S.s()"]);
    // The module is above the operation even when the type between them is not asked.
    expect(walked({ include: [id("java:p/A.N.m()")], levels: ["operation", "module"], closure: "containers" })).toEqual(["java:p", "java:p/A.N.m()"]);
    // An excluded container is skipped, the ones above it kept.
    expect(walked({ include: [id("java:p/A.N.m()")], exclude: [id("java:p/A")], closure: "containers" })).toEqual(["java:p", "java:p/A.N", "java:p/A.N.m()"]);
  });

  it("all: the least set closed under both", () => {
    // f's type A and module p; then everything p's prompt depends on, which is all of p.
    const all = walked({ include: [id(f)], closure: "all" });
    expect(all).toEqual(["java:p", "java:p/A", "java:p/A.N", "java:p/A.N.m()", "java:p/B", "java:p/B.g()", "java:p/C", "java:p/C.h()", f].sort());
    // p.sub depends on p, never the reverse: nothing of p.sub is reached.
    expect(all.some((u) => u.startsWith("java:p.sub"))).toBe(false);
  });

  it("the price: what each mode adds, and what the asked units depend on that is not asked", () => {
    const price = priceSelection(resolve(TOY, select({ include: [id(f)] })));
    const ops = (n: number, types = 0, modules = 0): Record<Level, number> => ({ operation: n, type: types, module: modules });
    expect(price.closure).toBe("none");
    expect(price.selected).toEqual(ops(1));
    expect(price.asked).toEqual(ops(1));
    expect(price.added).toEqual({ none: ops(0), dependencies: ops(2), containers: ops(0, 1, 1), all: ops(3, 4, 1) });
    expect(price.notWalked).toEqual({ unselected: ops(1), excluded: ops(0), outsideLevels: ops(0), trivial: ops(0) });
    expect(price.leftOut).toEqual(ops(4, 5, 2));
    expect(price.templated).toEqual(ops(0));
  });
});

describe("the price is what the plans show", () => {
  it.each(CLOSURES)("closure %s: a cold plan's skip-scope count falls by exactly what the mode adds", (closure: Closure) => {
    const base = select({ include: [id(`${ORDER}/OrderService`)] });
    const none = plan(JAVA, base);
    const other = plan(JAVA, { ...base, closure });
    const price = priceSelection(resolve(JAVA, base));
    for (const level of ["operation", "type", "module"] as const) {
      const skipped = (p: RunPlan): number => p.steps.filter((s) => s.unit.level === level && s.status === "skip-scope").length;
      expect(skipped(none) - skipped(other), level).toBe(price.added[closure][level]);
    }
  });
});

describe("selection under a view", () => {
  /** A corpus type whose package is a STUB: the only shape where a view drops a unit's nearest container. */
  function stubPackageCorpus(): CodeGraph {
    return graphOf([pkg("java:ext", true), type("java:ext/Mine", "java:ext"), method("java:ext/Mine.f()", "java:ext/Mine")]);
  }

  it("matches inside the view's projection: a container the view drops matches no include", () => {
    const graph = stubPackageCorpus();
    const internal = envOf(graph, internalOnly);
    expect(internal.walk.units.map((u) => u.id).sort()).toEqual(["java:ext/Mine", "java:ext/Mine.f()"]);
    const include = select({ include: [id("java:ext")] });
    expect(walkedIds(internal, include)).toEqual([]);
    // Compiled under the identity view (what `--scope` does, as it always matched the whole model) it does.
    expect(walkedIds({ ...internal, view: identityView }, include)).toEqual(["java:ext/Mine", "java:ext/Mine.f()"]);
  });
});
