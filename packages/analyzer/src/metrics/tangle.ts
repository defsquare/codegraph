import type { EntityId } from "@codegraph/core";
import { compareIds } from "../order.js";
import type { CycleEdge } from "./cycles.js";

/**
 * Minimum feedback set (Structure101's "tangle" cut): a minimal weighted set of
 * edges whose removal leaves the graph acyclic — the offending dependencies.
 *
 * The exact minimum feedback arc set is NP-hard, so this is the Eades–Lin–Smyth
 * "greedy removal" heuristic (Inf. Proc. Letters 47, 1993) adapted to weights:
 * build a vertex sequence by repeatedly stripping sinks (to the right), sources
 * (to the left), else the vertex maximizing outWeight − inWeight (to the left,
 * ties by id ascending); edges pointing backward in the sequence are the
 * candidate cut. A minimality pass then re-admits every candidate that no
 * longer closes a cycle, heaviest first — so the result is MINIMAL: removing it
 * leaves a DAG, and re-adding any single member restores a cycle. Both halves
 * are properties the test suite checks, heuristic or not.
 *
 * ITERATIVE throughout, like Tarjan in cycles.ts and for the same reason: real
 * corpora fold to components deep enough to exhaust V8's call stack, and the
 * 20 000-node ring in test/tangle.test.ts fails loudly on recursion.
 */

interface Vertex {
  readonly id: EntityId;
  outWeight: number;
  inWeight: number;
  alive: boolean;
  /** Sequence slot, assigned when the vertex is removed. */
  position: number;
}

/** Lazy max-heap entry — stale deltas are skipped on pop, never updated. */
interface HeapEntry {
  readonly id: EntityId;
  readonly delta: number;
}

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    const p = heap[parent];
    const c = heap[child];
    if (p === undefined || c === undefined) break;
    if (p.delta > c.delta || (p.delta === c.delta && compareIds(p.id, c.id) <= 0)) break;
    heap[parent] = c;
    heap[child] = p;
    child = parent;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined) return top;
  if (heap.length === 0) return top;
  heap[0] = last;
  let parent = 0;
  for (;;) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let best = parent;
    for (const child of [left, right]) {
      const b = heap[best];
      const c = heap[child];
      if (c !== undefined && b !== undefined) {
        if (c.delta > b.delta || (c.delta === b.delta && compareIds(c.id, b.id) < 0)) best = child;
      }
    }
    if (best === parent) return top;
    const swap = heap[parent];
    const chosen = heap[best];
    if (swap === undefined || chosen === undefined) return top;
    heap[parent] = chosen;
    heap[best] = swap;
    parent = best;
  }
}

/** `to` reaches `from` over the kept edges — iterative DFS, the cycle oracle. */
function closesCycle(edge: CycleEdge, kept: ReadonlyMap<EntityId, readonly CycleEdge[]>): boolean {
  const seen = new Set<EntityId>([edge.to]);
  const stack: EntityId[] = [edge.to];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) return false;
    if (node === edge.from) return true;
    for (const next of kept.get(node) ?? []) {
      if (!seen.has(next.to)) {
        seen.add(next.to);
        stack.push(next.to);
      }
    }
  }
}

/**
 * The minimal feedback set of `edges`, weighted by `count`. Self-loops are
 * ignored: a folding-induced self-dependency is not a link in any loop and can
 * never be cut. Returns a subset of `edges` — the SAME objects, so callers may
 * mark membership with a reference Set — sorted by (from, to) like every edge
 * list a metric hands out. A DAG input yields the empty set.
 */
export function feedbackArcSet(edges: readonly CycleEdge[]): readonly CycleEdge[] {
  const work = edges.filter((edge) => !edge.selfLoop && edge.from !== edge.to);
  if (work.length === 0) return [];

  // Vertices in sorted id order — the input order never leaks into the result.
  const vertices = new Map<EntityId, Vertex>();
  for (const edge of work) {
    for (const id of [edge.from, edge.to]) {
      if (!vertices.has(id)) {
        vertices.set(id, { id, outWeight: 0, inWeight: 0, alive: true, position: -1 });
      }
    }
  }
  const outgoing = new Map<EntityId, CycleEdge[]>();
  const incoming = new Map<EntityId, CycleEdge[]>();
  for (const edge of work) {
    const from = vertices.get(edge.from);
    const to = vertices.get(edge.to);
    if (from === undefined || to === undefined) continue;
    from.outWeight += edge.count;
    to.inWeight += edge.count;
    const out = outgoing.get(edge.from);
    if (out === undefined) outgoing.set(edge.from, [edge]);
    else out.push(edge);
    const inc = incoming.get(edge.to);
    if (inc === undefined) incoming.set(edge.to, [edge]);
    else inc.push(edge);
  }

  const ordered = [...vertices.values()].sort((a, b) => compareIds(a.id, b.id));
  const sinks: Vertex[] = [];
  const sources: Vertex[] = [];
  const heap: HeapEntry[] = [];
  for (const vertex of ordered) {
    if (vertex.outWeight === 0) sinks.push(vertex);
    else if (vertex.inWeight === 0) sources.push(vertex);
    heapPush(heap, { id: vertex.id, delta: vertex.outWeight - vertex.inWeight });
  }

  // Left-placed vertices take positions 0, 1, 2…; right-placed (sinks) count
  // down from the top — concatenating left ++ reverse(right) without arrays.
  let leftNext = 0;
  let rightNext = vertices.size - 1;

  const drop = (vertex: Vertex, position: number): void => {
    vertex.alive = false;
    vertex.position = position;
    for (const edge of outgoing.get(vertex.id) ?? []) {
      const to = vertices.get(edge.to);
      if (to === undefined || !to.alive) continue;
      to.inWeight -= edge.count;
      if (to.inWeight === 0 && to.outWeight > 0) sources.push(to);
      heapPush(heap, { id: to.id, delta: to.outWeight - to.inWeight });
    }
    for (const edge of incoming.get(vertex.id) ?? []) {
      const from = vertices.get(edge.from);
      if (from === undefined || !from.alive) continue;
      from.outWeight -= edge.count;
      if (from.outWeight === 0) sinks.push(from);
      heapPush(heap, { id: from.id, delta: from.outWeight - from.inWeight });
    }
  };

  let remaining = vertices.size;
  while (remaining > 0) {
    const sink = sinks.pop();
    if (sink !== undefined) {
      if (!sink.alive || sink.outWeight !== 0) continue;
      drop(sink, rightNext);
      rightNext -= 1;
      remaining -= 1;
      continue;
    }
    const source = sources.pop();
    if (source !== undefined) {
      if (!source.alive || source.inWeight !== 0) continue;
      drop(source, leftNext);
      leftNext += 1;
      remaining -= 1;
      continue;
    }
    const entry = heapPop(heap);
    if (entry === undefined) break;
    const vertex = vertices.get(entry.id);
    if (vertex === undefined || !vertex.alive) continue;
    if (entry.delta !== vertex.outWeight - vertex.inWeight) continue; // stale
    drop(vertex, leftNext);
    leftNext += 1;
    remaining -= 1;
  }

  const backward = new Set<CycleEdge>();
  for (const edge of work) {
    const from = vertices.get(edge.from);
    const to = vertices.get(edge.to);
    if (from !== undefined && to !== undefined && from.position > to.position) backward.add(edge);
  }

  // Minimality pass: re-admit, heaviest first, every candidate that no longer
  // closes a cycle over the kept edges — sparing the costliest cuts first.
  const kept = new Map<EntityId, CycleEdge[]>();
  for (const edge of work) {
    if (backward.has(edge)) continue;
    const list = kept.get(edge.from);
    if (list === undefined) kept.set(edge.from, [edge]);
    else list.push(edge);
  }
  const candidates = [...backward].sort(
    (a, b) => b.count - a.count || compareIds(a.from, b.from) || compareIds(a.to, b.to),
  );
  for (const edge of candidates) {
    if (closesCycle(edge, kept)) continue;
    backward.delete(edge);
    const list = kept.get(edge.from);
    if (list === undefined) kept.set(edge.from, [edge]);
    else list.push(edge);
  }

  return [...backward].sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
}
