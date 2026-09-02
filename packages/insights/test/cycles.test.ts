import { existsSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import {
  buildGraph,
  cycles,
  foldGraph,
  importGraph,
  loadDecodedModels,
  typeDependencyGraph,
  type CodeGraph,
} from "@codegraph/analyzer";
import { buildWalk, type WalkPlan } from "../src/order.js";
import { javaGraph, packageCorpus, prepared } from "./fixture.js";

/**
 * THE CYCLE SUITE. Mutually dependent packages are one unit — and so are
 * mutually dependent types and operations. The analyzer's own cycle report is
 * the oracle: its components at module level must be EXACTLY the multi-member
 * module units, and every type-level component must sit inside one type unit
 * (type units may be coarser, because a nested type also joins its outer type).
 */

function moduleUnits(plan: WalkPlan): string[][] {
  return plan.units.filter((u) => u.level === "module").map((u) => [...u.members]);
}

function walkOf(graph: CodeGraph): WalkPlan {
  const { units } = prepared(graph);
  return buildWalk(units, graph);
}

/** Module SCCs of size ≥ 2 per the analyzer, as sorted member lists. */
function oracleModuleCycles(graph: CodeGraph): string[][] {
  return cycles(importGraph(graph)).components.map((c) => [...c.members]);
}

describe("mutually dependent packages are one unit", () => {
  it("a ↔ b with c → a: one unit {a, b}, and c after it", () => {
    const plan = walkOf(packageCorpus(3, [[0, 1], [1, 0], [2, 0]]));
    const modules = moduleUnits(plan);
    expect(modules).toEqual([["java:p0", "java:p1"], ["java:p2"]]);
    const ab = plan.unitOf.get("java:p0")!;
    const c = plan.unitOf.get("java:p2")!;
    expect(plan.unitOf.get("java:p1")).toBe(ab);
    expect(c.deps).toContain(ab.id);
    expect(plan.units.indexOf(ab)).toBeLessThan(plan.units.indexOf(c));
  });

  it("a three-package ring collapses to one unit; a chain stays three", () => {
    expect(moduleUnits(walkOf(packageCorpus(3, [[0, 1], [1, 2], [2, 0]])))).toEqual([["java:p0", "java:p1", "java:p2"]]);
    expect(moduleUnits(walkOf(packageCorpus(3, [[0, 1], [1, 2]])))).toEqual([["java:p2"], ["java:p1"], ["java:p0"]]);
  });

  it("the cycle's types are still explained before the cycle's modules", () => {
    const plan = walkOf(packageCorpus(2, [[0, 1], [1, 0]]));
    const at = new Map(plan.units.map((u, i) => [u.id, i]));
    const modules = plan.unitOf.get("java:p0")!;
    for (const t of ["java:p0/C", "java:p1/C"]) expect(at.get(plan.unitOf.get(t)!.id)).toBeLessThan(at.get(modules.id) ?? -1);
    // The two classes reference each other, so they are one type unit — one dep.
    const typeUnits = [...new Set(["java:p0/C", "java:p1/C"].map((t) => plan.unitOf.get(t)!.id))].sort();
    expect(modules.deps).toEqual(typeUnits);
  });

  it("property: module units are exactly the import-graph SCCs, and the unit graph is acyclic", () => {
    const arb = fc
      .integer({ min: 1, max: 7 })
      .chain((n) =>
        fc
          .array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), { maxLength: 20 })
          .map((imports) => ({ n, imports })),
      );
    fc.assert(
      fc.property(arb, ({ n, imports }) => {
        const graph = packageCorpus(n, imports);
        const plan = walkOf(graph);
        const multi = moduleUnits(plan).filter((u) => u.length >= 2).sort();
        expect(multi).toEqual(oracleModuleCycles(graph).sort());
        const at = new Map(plan.units.map((u, i) => [u.id, i]));
        plan.units.forEach((u, i) => u.deps.forEach((d) => expect(at.get(d)).toBeLessThan(i)));
      }),
    );
  });
});

/** The oracle cross-check, over any corpus. */
function crossCheck(graph: CodeGraph): void {
  const plan = walkOf(graph);
  // Module level: exact.
  const multi = moduleUnits(plan).filter((u) => u.length >= 2).sort();
  expect(multi).toEqual(oracleModuleCycles(graph).sort());
  // Type level: every analyzer component lies inside one unit.
  for (const component of cycles(typeDependencyGraph(graph)).components) {
    const owners = new Set(component.members.map((id) => plan.unitOf.get(id)?.id));
    owners.delete(undefined); // stub members are not units
    expect(owners.size).toBeLessThanOrEqual(1);
  }
  // No unit mixes levels; deps always precede.
  const at = new Map(plan.units.map((u, i) => [u.id, i]));
  plan.units.forEach((u, i) => u.deps.forEach((d) => expect(at.get(d)).toBeLessThan(i)));
  // Sanity for the module fold the oracle uses.
  expect(foldGraph(graph, { level: "module" }).nodes.length).toBeGreaterThan(0);
}

describe("oracle cross-check against the analyzer's cycle report", () => {
  it("holds on the Java fixture", () => {
    crossCheck(javaGraph());
  });

  const corpus = process.env["CODEGRAPH_CORPUS_MODEL"];
  const available = corpus !== undefined && existsSync(corpus);
  it.skipIf(!available)(`holds on ${corpus ?? "CODEGRAPH_CORPUS_MODEL (unset)"}`, () => {
    const model = readModelFileSync(corpus!);
    const graph = buildGraph(loadDecodedModels([model], { sources: [corpus!] }).union);
    crossCheck(graph);
    const plan = walkOf(graph);
    const tangles = moduleUnits(plan).filter((u) => u.length >= 2);
    // A real corpus with package tangles is the point of this run: say so.
    console.log(`${corpus}: ${plan.units.length} units, ${tangles.length} module tangles, largest ${Math.max(0, ...tangles.map((t) => t.length))}`);
  }, 600_000);
});
