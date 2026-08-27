import { describe, expect, it } from "vitest";
import type { CycleEdge } from "../src/metrics/cycles.js";
import { feedbackArcSet } from "../src/metrics/tangle.js";

/**
 * Every expected set below was derived BY HAND from the documented algorithm
 * (weighted ELS-GR vertex sequence + minimality pass, tie-breaks by id
 * ascending) — a test that only checks "some edges come back" proves nothing.
 * Where the true minimum is known (edge-disjoint cycles), the pin is optimal,
 * not merely the heuristic's answer.
 */

function cycleEdge(from: string, to: string, count = 1): CycleEdge {
  return {
    from,
    to,
    count,
    kinds: ["reference"],
    provenances: ["declared"],
    allDeclared: true,
    selfLoop: from === to,
  };
}

function pairs(edges: readonly CycleEdge[]): [string, string][] {
  return edges.map((e) => [e.from, e.to]);
}

/** Iterative reachability over an edge list — the test's own oracle. */
function reaches(from: string, to: string, edges: readonly CycleEdge[]): boolean {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from);
    if (list === undefined) out.set(e.from, [e.to]);
    else list.push(e.to);
  }
  const seen = new Set<string>([from]);
  const stack = [from];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) return false;
    if (node === to) return true;
    for (const next of out.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
}

function hasCycle(edges: readonly CycleEdge[]): boolean {
  return edges.some((e) => reaches(e.to, e.from, edges));
}

/** Removing the set leaves a DAG; re-adding any single edge restores a cycle. */
function expectMinimalFeedback(edges: readonly CycleEdge[], cut: readonly CycleEdge[]): void {
  const cutSet = new Set(cut);
  const kept = edges.filter((e) => !e.selfLoop && !cutSet.has(e));
  expect(hasCycle(kept)).toBe(false);
  for (const e of cut) expect(reaches(e.to, e.from, kept)).toBe(true);
}

describe("feedbackArcSet on hand-built cycles", () => {
  it("returns nothing when there is nothing to cut", () => {
    expect(feedbackArcSet([])).toEqual([]);
    expect(feedbackArcSet([cycleEdge("A", "B"), cycleEdge("B", "C")])).toEqual([]);
  });

  it("cuts the lighter side of an unbalanced 2-cycle", () => {
    const edges = [cycleEdge("A", "B", 5), cycleEdge("B", "A", 1)];
    expect(pairs(feedbackArcSet(edges))).toEqual([["B", "A"]]);
  });

  it("breaks an even 2-cycle deterministically: the edge into the smaller id", () => {
    // The delta tie falls to the smaller id, which is sequenced first, so the
    // backward edge — the cut — is the one pointing INTO it.
    const edges = [cycleEdge("A", "B"), cycleEdge("B", "A")];
    expect(pairs(feedbackArcSet(edges))).toEqual([["B", "A"]]);
  });

  it("cuts exactly one edge of a uniform 3-ring", () => {
    const edges = [cycleEdge("A", "B"), cycleEdge("B", "C"), cycleEdge("C", "A")];
    expect(pairs(feedbackArcSet(edges))).toEqual([["C", "A"]]);
  });

  it("spares the heavy edges of a weighted ring", () => {
    const edges = [cycleEdge("A", "B", 10), cycleEdge("B", "C", 10), cycleEdge("C", "A", 1)];
    const cut = feedbackArcSet(edges);
    expect(pairs(cut)).toEqual([["C", "A"]]);
    expectMinimalFeedback(edges, cut);
  });

  it("needs two cuts for two rings sharing a node", () => {
    const edges = [
      cycleEdge("A", "B"),
      cycleEdge("B", "A"),
      cycleEdge("B", "C"),
      cycleEdge("C", "B"),
    ];
    const cut = feedbackArcSet(edges);
    expect(pairs(cut)).toEqual([
      ["B", "A"],
      ["C", "B"],
    ]);
    expectMinimalFeedback(edges, cut);
  });

  it("is optimal when the cycles are edge-disjoint", () => {
    // Three mutual pairs; A<->C carries weight 10 a side. The 2-cycles share no
    // edge, so ANY feedback set costs at least 1 + 1 + 10 = 12 — the answer
    // below is not just minimal, it is the minimum.
    const edges = [
      cycleEdge("A", "B", 1),
      cycleEdge("B", "A", 1),
      cycleEdge("B", "C", 1),
      cycleEdge("C", "B", 1),
      cycleEdge("A", "C", 10),
      cycleEdge("C", "A", 10),
    ];
    const cut = feedbackArcSet(edges);
    expect(pairs(cut)).toEqual([
      ["B", "A"],
      ["C", "A"],
      ["C", "B"],
    ]);
    expect(cut.reduce((sum, e) => sum + e.count, 0)).toBe(12);
    expectMinimalFeedback(edges, cut);
  });

  it("stays minimal and deterministic on a dense overlapping-cycle graph", () => {
    const edges = [
      cycleEdge("A", "B", 3),
      cycleEdge("B", "C", 1),
      cycleEdge("C", "A", 2),
      cycleEdge("C", "D", 4),
      cycleEdge("D", "B", 1),
      cycleEdge("D", "E", 2),
      cycleEdge("E", "C", 5),
      cycleEdge("E", "A", 1),
      cycleEdge("A", "D", 2),
    ];
    const once = feedbackArcSet(edges);
    expectMinimalFeedback(edges, once);
    expect(feedbackArcSet(edges)).toEqual(once);
    // Subset of the input, by reference, sorted by (from, to).
    for (const e of once) expect(edges.includes(e)).toBe(true);
    const sorted = [...pairs(once)].sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
    );
    expect(pairs(once)).toEqual(sorted);
  });

  it("never cuts a self-loop", () => {
    const edges = [cycleEdge("A", "A", 7), cycleEdge("A", "B"), cycleEdge("B", "A")];
    expect(pairs(feedbackArcSet(edges))).toEqual([["B", "A"]]);
  });
});

describe("feedbackArcSet is iterative — depth must not reach the call stack", () => {
  it("cuts a 20 000-node ring with one edge and no recursion", () => {
    const SIZE = 20_000;
    const ids = Array.from({ length: SIZE }, (_, i) => `n${String(i).padStart(6, "0")}`);
    const edges: CycleEdge[] = [];
    for (let i = 0; i + 1 < SIZE; i += 1) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from !== undefined && to !== undefined) edges.push(cycleEdge(from, to));
    }
    edges.push(cycleEdge(ids[SIZE - 1] ?? "", ids[0] ?? ""));
    const cut = feedbackArcSet(edges);
    expect(pairs(cut)).toEqual([[ids[SIZE - 1] ?? "", ids[0] ?? ""]]);
  });
});
