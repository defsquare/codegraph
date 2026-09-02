import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Edge, Entity } from "@codegraph/core";
import { buildWalk, dependencyEdges, type WalkPlan } from "../src/order.js";
import { edge, graphOf, javaGraph, method, pkg, prepared, type } from "./fixture.js";

const P = "java:p";
const T = "java:p/T";
const m = (name: string): string => `${T}.${name}()`;

/** A single class with `n` methods and `calls` between them (indexes). */
function callCorpus(n: number, calls: readonly (readonly [number, number])[]) {
  const entities: Entity[] = [pkg(P), type(T, P)];
  for (let i = 0; i < n; i += 1) entities.push(method(m(`f${i}`), T));
  const edges: Edge[] = calls.map(([a, b]) => edge("invocation", m(`f${a}`), m(`f${b}`)));
  return prepared(graphOf(entities, edges));
}

function position(plan: WalkPlan): ReadonlyMap<string, number> {
  return new Map(plan.units.map((u, i) => [u.id, i]));
}

const arbCalls = fc
  .integer({ min: 1, max: 9 })
  .chain((n) =>
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), { maxLength: 24 })
      .map((calls) => ({ n, calls })),
  );

describe("buildWalk over operations", () => {
  it("visits a callee before its caller and the type after its members", () => {
    const { graph, units } = callCorpus(3, [[0, 1], [1, 2]]);
    const plan = buildWalk(units, graph);
    const at = position(plan);
    expect(at.get(m("f2"))).toBeLessThan(at.get(m("f1")) ?? -1);
    expect(at.get(m("f1"))).toBeLessThan(at.get(m("f0")) ?? -1);
    expect(at.get(T)).toBeGreaterThan(at.get(m("f0")) ?? Infinity);
    expect(at.get(P)).toBeGreaterThan(at.get(T) ?? Infinity);
    expect(plan.unitOf.get(T)?.deps).toEqual([m("f0"), m("f1"), m("f2")]);
    expect(plan.unitOf.get(P)?.deps).toEqual([T]);
    expect(plan.layers.map((l) => l.map((u) => u.id))).toEqual([[m("f2")], [m("f1")], [m("f0")], [T], [P]]);
  });

  it("merges mutually recursive methods into one unit whose record lists both", () => {
    const { graph, units } = callCorpus(3, [[0, 1], [1, 0], [1, 2]]);
    const plan = buildWalk(units, graph);
    const cycle = plan.unitOf.get(m("f0"));
    expect(cycle?.members).toEqual([m("f0"), m("f1")]);
    expect(plan.unitOf.get(m("f1"))).toBe(cycle);
    expect(cycle?.deps).toEqual([m("f2")]);
    expect(cycle?.layer).toBe(1);
  });

  it("ignores a recursive self-call and external calls", () => {
    const entities: Entity[] = [pkg(P), type(T, P), method(m("f"), T), pkg("java:java.util", true), type("java:java.util/List", "java:java.util", { isStub: true })];
    const graph = graphOf(entities, [
      edge("invocation", m("f"), m("f")),
      edge("invocation", m("f"), "java:java.util/List"),
    ]);
    const { units } = prepared(graph);
    expect(dependencyEdges(units, graph).get(m("f"))).toEqual([]);
    expect(buildWalk(units, graph).unitOf.get(m("f"))?.members).toEqual([m("f")]);
  });

  it("property: every callee precedes its caller unless they share a unit; members precede containers", () => {
    fc.assert(
      fc.property(arbCalls, ({ n, calls }) => {
        const { graph, units } = callCorpus(n, calls);
        const plan = buildWalk(units, graph);
        const at = position(plan);
        for (const [a, b] of calls) {
          if (a === b) continue;
          const caller = plan.unitOf.get(m(`f${a}`))!;
          const callee = plan.unitOf.get(m(`f${b}`))!;
          if (caller === callee) continue;
          expect(at.get(callee.id)).toBeLessThan(at.get(caller.id) ?? -1);
        }
        for (let i = 0; i < n; i += 1) expect(at.get(plan.unitOf.get(m(`f${i}`))!.id)).toBeLessThan(at.get(T) ?? -1);
        expect(at.get(T)).toBeLessThan(at.get(P) ?? -1);
        // Every unit's deps are earlier.
        plan.units.forEach((unit, index) => {
          for (const dep of unit.deps) expect(at.get(dep)).toBeLessThan(index);
        });
      }),
    );
  });

  it("property: the plan is a function of the graph, not of insertion order", () => {
    fc.assert(
      fc.property(arbCalls, fc.array(fc.nat(), { minLength: 24, maxLength: 24 }), ({ n, calls }, salt) => {
        const shuffled = [...calls].sort((a, b) => (salt[calls.indexOf(a)] ?? 0) - (salt[calls.indexOf(b)] ?? 0));
        const a = buildWalk(callCorpus(n, calls).units, callCorpus(n, calls).graph);
        const { graph, units } = callCorpus(n, shuffled);
        const b = buildWalk(units, graph);
        expect(JSON.stringify(b.units)).toBe(JSON.stringify(a.units));
      }),
    );
  });
});

describe("buildWalk over the Java fixture", () => {
  it("orders every unit after its dependencies and mixes no levels inside a unit", () => {
    const { graph, units } = prepared(javaGraph());
    const plan = buildWalk(units, graph);
    const at = position(plan);
    expect(plan.units.length).toBe(units.operations.size + units.types.size + units.modules.size - plan.units.reduce((n, u) => n + u.members.length - 1, 0));
    plan.units.forEach((unit, index) => {
      for (const dep of unit.deps) expect(at.get(dep)).toBeLessThan(index);
      for (const member of unit.members) expect(units.levelOf(member)).toBe(unit.level);
    });
    const levelsInOrder = plan.units.map((u) => u.level);
    expect(levelsInOrder.indexOf("type")).toBeGreaterThan(levelsInOrder.lastIndexOf("operation") - plan.units.length);
    expect(plan.units.filter((u) => u.level === "module").length).toBeGreaterThan(0);
  });
});
