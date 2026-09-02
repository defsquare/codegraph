import { compareIds, sortIds } from "./order.js";

/**
 * Strongly connected components and their condensation, over ANY digraph
 * given as `(nodes, successors)` — a folded graph for the cycle report, the
 * entity-level call graph or the module import graph for a bottom-up walk.
 *
 * Tarjan, ITERATIVE — an explicit frame stack, never recursion. This is
 * deliberate and must stay that way: the textbook formulation recurses once
 * per node on the DFS path, and a folded graph of 15 000 nodes (the order
 * apache/commons-lang folds to) exhausts V8's call stack. The failure presents
 * as `Maximum call stack size exceeded` thrown from inside a metric — an
 * inscrutable crash that appears only on real corpora, because every hand-built
 * test graph is shallow enough to survive. The 20 000-node cases in
 * `test/scc.test.ts` and `test/cycles.test.ts` fail loudly if anyone
 * "simplifies" this back to recursion.
 *
 * Pure computation over opaque string ids (analyzer decision 6: ordering is
 * applied once, by the caller or by `condense`, never inside the DFS).
 */

/** A DFS frame: the node, its successors, and how far we got. */
interface Frame<T> {
  readonly node: T;
  readonly successors: readonly T[];
  next: number;
}

/**
 * Tarjan's SCC, iterative. Returns the raw components, unsorted. Successors
 * outside `nodes` are ignored (a dangling target is not a node of the graph).
 * Roots are taken in `nodes` order, so a sorted input gives a deterministic DFS.
 */
export function stronglyConnectedComponents<T extends string>(
  nodes: readonly T[],
  successors: (node: T) => readonly T[],
): T[][] {
  const known = new Set<T>(nodes);
  const index = new Map<T, number>();
  const lowlink = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const components: T[][] = [];
  let counter = 0;

  // The recursive call is replaced by pushing a frame; `open` is what the
  // prologue of the recursive function would do.
  const open = (id: T, frames: Frame<T>[]): void => {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    frames.push({ node: id, successors: successors(id), next: 0 });
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: Frame<T>[] = [];
    open(root, frames);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const v = frame.node;

      if (frame.next < frame.successors.length) {
        const w = frame.successors[frame.next];
        frame.next += 1;
        if (w === undefined || !known.has(w)) continue;
        const wIndex = index.get(w);
        if (wIndex === undefined) {
          open(w, frames);
        } else if (onStack.has(w)) {
          // Back edge into the current DFS stack: v can reach w's depth.
          const vLow = lowlink.get(v);
          if (vLow === undefined || wIndex < vLow) lowlink.set(v, wIndex);
        }
        continue;
      }

      // v is exhausted — this is the epilogue of the recursive call.
      const vIndex = index.get(v) ?? 0;
      const vLow = lowlink.get(v) ?? 0;
      if (vLow === vIndex) {
        const component: T[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === v) break;
        }
        components.push(component);
      }
      frames.pop();
      const caller = frames[frames.length - 1];
      if (caller !== undefined) {
        const callerLow = lowlink.get(caller.node);
        if (callerLow === undefined || vLow < callerLow) lowlink.set(caller.node, vLow);
      }
    }
  }

  return components;
}

/**
 * The condensation: one node per component, one edge per collapsed
 * inter-component edge. Acyclic by construction, so a consumer can layer it
 * (Kahn) to visit dependencies before dependents — the walk order a bottom-up
 * explanation needs, with a cycle's members visited together.
 */
export interface Condensation<T extends string> {
  /** Members sorted by id; components sorted by their first member. */
  readonly components: readonly (readonly T[])[];
  /** Node → index into `components`. */
  readonly componentOf: ReadonlyMap<T, number>;
  /** Per component, the sorted distinct indexes of the components it depends on — never itself. */
  readonly successors: readonly (readonly number[])[];
}

/** Total order on components: disjoint and internally sorted, so members decide. */
export function compareComponents(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareIds(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

export function condense<T extends string>(
  nodes: readonly T[],
  successors: (node: T) => readonly T[],
): Condensation<T> {
  const sortedNodes = sortIds(nodes);
  const components = stronglyConnectedComponents(sortedNodes, successors).map((c) => sortIds(c));
  components.sort(compareComponents);

  const componentOf = new Map<T, number>();
  components.forEach((members, position) => {
    for (const member of members) componentOf.set(member, position);
  });

  const collapsed: Set<number>[] = components.map(() => new Set<number>());
  for (const node of sortedNodes) {
    const from = componentOf.get(node);
    if (from === undefined) continue;
    for (const target of successors(node)) {
      const to = componentOf.get(target);
      if (to === undefined || to === from) continue;
      collapsed[from]?.add(to);
    }
  }

  return {
    components,
    componentOf,
    successors: collapsed.map((set) => [...set].sort((a, b) => a - b)),
  };
}
