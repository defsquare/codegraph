import type { EdgeKind, EntityId, Provenance } from "@codegraph/core";
import type { FoldedEdge, FoldedGraph, FoldLevel } from "../fold.js";
import { compareIds, sortIds, sortedUnique } from "../order.js";
import type { ViewDescriptor } from "../views.js";

/**
 * Stage 6: cycle detection (decision 5, PLAN.md §6.4, METAMODEL.md §9).
 *
 * Tarjan strongly connected components, ITERATIVE — an explicit frame stack,
 * never recursion. This is deliberate and must stay that way: the textbook
 * formulation recurses once per node on the DFS path, and a folded graph of
 * 15 000 nodes (the order apache/commons-lang folds to) exhausts V8's call
 * stack. The failure presents as `Maximum call stack size exceeded` thrown from
 * inside a metric — an inscrutable crash that appears only on real corpora,
 * because every hand-built test graph is shallow enough to survive. The deep
 * chain cases in `test/cycles.test.ts` fail loudly if anyone "simplifies" this
 * back to recursion.
 *
 * Pure computation: the folded graph is only read, and nothing here is an
 * inverse index that could reach disk (CLAUDE.md invariant 4).
 */

/**
 * One aggregated edge inside a cycle — the material a user needs to BREAK it.
 * A bare list of node ids says a problem exists and nothing about how to fix
 * it: `count` is how many base edges hold this link together (the cost of
 * cutting it) and `provenances` says whether the link is a declared fact or an
 * inference the extractor made (CLAUDE.md invariant 2).
 *
 * Sets are flattened to sorted arrays here on purpose: a cycle report is meant
 * to be serialized, and `JSON.stringify(new Set())` is `{}`.
 */
export interface CycleEdge {
  readonly from: EntityId;
  readonly to: EntityId;
  /** Base edges aggregated into this link — the weight of the dependency. */
  readonly count: number;
  /** Sorted. */
  readonly kinds: readonly EdgeKind[];
  /** Sorted. */
  readonly provenances: readonly Provenance[];
  /** True only when every aggregated base edge is a `declared` fact. */
  readonly allDeclared: boolean;
  /** True when the link is a folding-induced self-dependency. */
  readonly selfLoop: boolean;
}

export interface StronglyConnectedComponent {
  /** Members sorted by id. */
  readonly members: readonly EntityId[];
  readonly size: number;
  /** Folded edges whose endpoints are both in this component (self-loops included). */
  readonly internalEdgeCount: number;
  /** Sum of `FoldedEdge.count` over those edges — the base-edge weight of the cycle. */
  readonly weight: number;
  /**
   * Those same edges, sorted by (from, to): which concrete dependency to attack,
   * how much it carries, and whether it is a fact or an inference. A member's
   * self-loop is internal to the component but is never a link IN the loop —
   * filter on `CycleEdge.selfLoop` when choosing an edge to cut.
   */
  readonly edges: readonly CycleEdge[];
}

export interface CycleReport {
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  /** SCCs of size >= minSize, sorted by first member. */
  readonly components: readonly StronglyConnectedComponent[];
  /** Nodes carrying a folding-induced self-loop, sorted. */
  readonly selfLoops: readonly EntityId[];
}

export interface CyclesOptions {
  /** Smallest component size reported. Defaults to 2. */
  readonly minSize?: number;
}

/** A DFS frame: the node, its (already sorted) successors, and how far we got. */
interface Frame {
  readonly node: EntityId;
  readonly successors: readonly FoldedEdge[];
  next: number;
}

/**
 * Tarjan's SCC, iterative. Returns the raw components, unsorted — ordering is
 * applied once, in `cycles`, so determinism has a single owner (decision 6).
 */
function stronglyConnectedComponents(folded: FoldedGraph): EntityId[][] {
  const index = new Map<EntityId, number>();
  const lowlink = new Map<EntityId, number>();
  const onStack = new Set<EntityId>();
  const stack: EntityId[] = [];
  const components: EntityId[][] = [];
  let counter = 0;

  // The recursive call is replaced by pushing a frame; `open` is what the
  // prologue of the recursive function would do.
  const open = (id: EntityId, frames: Frame[]): void => {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    frames.push({ node: id, successors: folded.outgoing(id), next: 0 });
  };

  // Roots are taken in node order (sorted), so the DFS itself is deterministic.
  for (const root of folded.nodes) {
    if (index.has(root.id)) continue;
    const frames: Frame[] = [];
    open(root.id, frames);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const v = frame.node;

      if (frame.next < frame.successors.length) {
        const successor = frame.successors[frame.next];
        frame.next += 1;
        if (successor === undefined) continue;
        const w = successor.to;
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
      // Both were set by `open` when the frame was pushed.
      const vIndex = index.get(v) ?? 0;
      const vLow = lowlink.get(v) ?? 0;
      if (vLow === vIndex) {
        const component: EntityId[] = [];
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

function toCycleEdge(edge: FoldedEdge): CycleEdge {
  const provenances = sortIds<Provenance>(edge.provenances);
  return {
    from: edge.from,
    to: edge.to,
    count: edge.count,
    kinds: sortIds<EdgeKind>(edge.kinds),
    provenances,
    allDeclared: provenances.length === 1 && provenances[0] === "declared",
    selfLoop: edge.selfLoop,
  };
}

/** Total order on components: disjoint and internally sorted, so members decide. */
function compareComponents(a: readonly EntityId[], b: readonly EntityId[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareIds(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Cycles in a folded graph, at whatever level and under whatever view it was
 * built — the report repeats both, because a cycle list without its view is not
 * a fact (decision 4).
 *
 * Components of size 1 are not cycles and are not reported; a node that depends
 * on ITSELF after folding is reported separately in `selfLoops`, because at type
 * level that is usually a method calling a sibling, not an architectural cycle.
 */
export function cycles(folded: FoldedGraph, options?: CyclesOptions): CycleReport {
  // A component of size 0 does not exist, and a non-finite threshold (a CLI flag
  // that failed to parse) must not silently turn into "report everything".
  const requested = options?.minSize;
  const minSize = requested === undefined || !Number.isFinite(requested) ? 2 : Math.max(1, requested);
  const membership = new Map<EntityId, number>();
  const memberLists: EntityId[][] = [];

  for (const component of stronglyConnectedComponents(folded)) {
    if (component.length < minSize) continue;
    memberLists.push(sortIds(component));
  }
  memberLists.sort(compareComponents);
  memberLists.forEach((members, position) => {
    for (const member of members) membership.set(member, position);
  });

  const internal: CycleEdge[][] = memberLists.map(() => []);
  const weights: number[] = memberLists.map(() => 0);
  const selfLooping: EntityId[] = [];

  // `folded.edges` is already sorted by (from, to), so every derived list here
  // inherits that order without re-sorting.
  for (const edge of folded.edges) {
    if (edge.selfLoop) selfLooping.push(edge.from);
    const from = membership.get(edge.from);
    if (from === undefined || from !== membership.get(edge.to)) continue;
    internal[from]?.push(toCycleEdge(edge));
    weights[from] = (weights[from] ?? 0) + edge.count;
  }

  const components: StronglyConnectedComponent[] = memberLists.map((members, position) => {
    const edges = internal[position] ?? [];
    return {
      members,
      size: members.length,
      internalEdgeCount: edges.length,
      weight: weights[position] ?? 0,
      edges,
    };
  });

  return {
    level: folded.level,
    view: folded.view,
    components,
    selfLoops: sortedUnique(selfLooping),
  };
}

/**
 * The folding-induced self-dependencies, with the detail `CycleReport.selfLoops`
 * deliberately omits: a self-loop that is entirely `derived` is an inference
 * about a node depending on itself, not a fact about one.
 */
export function selfLoopEdges(folded: FoldedGraph): readonly CycleEdge[] {
  return folded.edges.filter((edge) => edge.selfLoop).map(toCycleEdge);
}
