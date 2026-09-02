import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareIds } from "../src/order.js";
import { condense, stronglyConnectedComponents } from "../src/scc.js";

/**
 * A digraph as an adjacency table over string node ids. Nodes are `n0..n{k-1}`
 * and the successor function is derived from the table, so every property
 * below runs over the same shape a folded graph or an insights walk would
 * hand in.
 */
type Digraph = { readonly nodes: readonly string[]; readonly adjacency: ReadonlyMap<string, readonly string[]> };

function digraph(nodeCount: number, pairs: readonly (readonly [number, number])[]): Digraph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of pairs) adjacency.get(`n${from}`)?.push(`n${to}`);
  return { nodes, adjacency };
}

function successorsOf(g: Digraph): (node: string) => readonly string[] {
  return (node) => g.adjacency.get(node) ?? [];
}

const arbDigraph = fc
  .integer({ min: 1, max: 12 })
  .chain((n) =>
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), {
        maxLength: 40,
      })
      .map((pairs) => digraph(n, pairs)),
  );

/** Reachability by plain BFS — the oracle every SCC claim is checked against. */
function reaches(g: Digraph, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    if (current === to) return true;
    for (const next of g.adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

describe("stronglyConnectedComponents", () => {
  it("collapses a two-node cycle and keeps a chain apart", () => {
    const cycle = digraph(2, [[0, 1], [1, 0]]);
    expect(stronglyConnectedComponents(cycle.nodes, successorsOf(cycle))).toHaveLength(1);
    const chain = digraph(3, [[0, 1], [1, 2]]);
    expect(stronglyConnectedComponents(chain.nodes, successorsOf(chain))).toHaveLength(3);
  });

  it("puts every node in exactly one component", () => {
    fc.assert(
      fc.property(arbDigraph, (g) => {
        const components = stronglyConnectedComponents(g.nodes, successorsOf(g));
        const flat = components.flat();
        expect(flat.length).toBe(g.nodes.length);
        expect(new Set(flat).size).toBe(g.nodes.length);
      }),
    );
  });

  it("groups two nodes iff each reaches the other", () => {
    fc.assert(
      fc.property(arbDigraph, (g) => {
        const components = stronglyConnectedComponents(g.nodes, successorsOf(g));
        const of = new Map<string, number>();
        components.forEach((c, i) => c.forEach((n) => of.set(n, i)));
        for (const a of g.nodes) {
          for (const b of g.nodes) {
            const together = of.get(a) === of.get(b);
            const mutual = reaches(g, a, b) && reaches(g, b, a);
            expect(together).toBe(mutual);
          }
        }
      }),
    );
  });

  it("survives a 20 000-node chain and ring without recursion", () => {
    const n = 20_000;
    const chainPairs: [number, number][] = [];
    for (let i = 0; i + 1 < n; i += 1) chainPairs.push([i, i + 1]);
    const chain = digraph(n, chainPairs);
    expect(stronglyConnectedComponents(chain.nodes, successorsOf(chain))).toHaveLength(n);
    const ring = digraph(n, [...chainPairs, [n - 1, 0]]);
    expect(stronglyConnectedComponents(ring.nodes, successorsOf(ring))).toHaveLength(1);
  });
});

describe("condense", () => {
  it("sorts members, orders components by first member and maps every node", () => {
    const g = digraph(5, [[3, 1], [1, 3], [0, 4], [4, 2]]);
    const c = condense(g.nodes, successorsOf(g));
    expect(c.components).toEqual([["n0"], ["n1", "n3"], ["n2"], ["n4"]]);
    expect([...c.componentOf.entries()].sort((a, b) => compareIds(a[0], b[0]))).toEqual([
      ["n0", 0],
      ["n1", 1],
      ["n2", 2],
      ["n3", 1],
      ["n4", 3],
    ]);
    // n0 → n4 → n2: component successors follow the collapsed edges, sorted.
    expect(c.successors).toEqual([[3], [], [], [2]]);
  });

  it("yields an acyclic component graph with no self-successor", () => {
    fc.assert(
      fc.property(arbDigraph, (g) => {
        const c = condense(g.nodes, successorsOf(g));
        // Kahn: every component must eventually reach in-degree zero.
        const indegree = c.successors.map(() => 0);
        c.successors.forEach((succ, i) => {
          expect(succ).not.toContain(i);
          expect([...succ]).toEqual([...new Set(succ)].sort((a, b) => a - b));
          for (const s of succ) indegree[s] = (indegree[s] ?? 0) + 1;
        });
        const ready = indegree.flatMap((d, i) => (d === 0 ? [i] : []));
        let seen = 0;
        while (ready.length > 0) {
          const i = ready.pop() ?? 0;
          seen += 1;
          for (const s of c.successors[i] ?? []) {
            indegree[s] = (indegree[s] ?? 0) - 1;
            if (indegree[s] === 0) ready.push(s);
          }
        }
        expect(seen).toBe(c.components.length);
      }),
    );
  });

  it("is deterministic under input permutation", () => {
    fc.assert(
      fc.property(arbDigraph, fc.array(fc.nat(), { minLength: 12, maxLength: 12 }), (g, salt) => {
        const shuffled = [...g.nodes].sort(
          (a, b) => (salt[Number(a.slice(1)) % 12] ?? 0) - (salt[Number(b.slice(1)) % 12] ?? 0),
        );
        const a = condense(g.nodes, successorsOf(g));
        const b = condense(shuffled, successorsOf(g));
        expect(JSON.stringify(b.components)).toBe(JSON.stringify(a.components));
        expect(JSON.stringify(b.successors)).toBe(JSON.stringify(a.successors));
      }),
    );
  });
});
