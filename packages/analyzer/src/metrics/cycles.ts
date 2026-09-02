import type { EdgeKind, EntityId, Provenance } from "@codegraph/core";
import type { FoldedEdge, FoldedGraph, FoldLevel } from "../fold.js";
import { sortIds, sortedUnique } from "../order.js";
import { compareComponents, stronglyConnectedComponents } from "../scc.js";
import type { ViewDescriptor } from "../views.js";
import { feedbackArcSet } from "./tangle.js";

/**
 * Stage 6: cycle detection (decision 5, PLAN.md §6.4, METAMODEL.md §9).
 *
 * The strongly connected components come from `../scc.ts` — the one iterative
 * Tarjan in the workspace, shared with every other consumer that needs a
 * condensation. This module turns raw components into a REPORT: which folded
 * edges hold each cycle together, how heavy they are, and which minimal cut
 * breaks them.
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
  /**
   * The minimum feedback set (Structure101's tangle cut): a minimal subset of
   * `edges` — the SAME objects, never a self-loop, sorted by (from, to) —
   * whose removal leaves the component acyclic. Heuristic (see tangle.ts) but
   * minimal by construction: re-adding any single member restores a cycle.
   */
  readonly feedbackEdges: readonly CycleEdge[];
  /** Sum of `feedbackEdges` counts — the base-edge references the cut severs. */
  readonly feedbackWeight: number;
  /**
   * feedbackWeight / the component's non-self internal weight, in [0, 1] —
   * Structure101's tangle metric. Self-loops are excluded from BOTH sides:
   * the metric scores references BETWEEN members, and a folding-induced
   * self-dependency is cohesion inside one member, never a cuttable link.
   * 0 — not NaN — when there is no non-self edge (only possible at minSize 1).
   */
  readonly tangleMetric: number;
}

/** The report-wide tangle roll-up: the union of every component's cut. */
export interface TangleSummary {
  readonly feedbackEdgeCount: number;
  readonly feedbackWeight: number;
  /** Non-self internal weight summed over the reported components. */
  readonly cyclicWeight: number;
  /** feedbackWeight / cyclicWeight; 0 — not NaN — on an acyclic graph. */
  readonly metric: number;
}

export interface CycleReport {
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  /** SCCs of size >= minSize, sorted by first member. */
  readonly components: readonly StronglyConnectedComponent[];
  /** Nodes carrying a folding-induced self-loop, sorted. */
  readonly selfLoops: readonly EntityId[];
  readonly tangle: TangleSummary;
}

export interface CyclesOptions {
  /** Smallest component size reported. Defaults to 2. */
  readonly minSize?: number;
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

  const nodeIds = folded.nodes.map((node) => node.id);
  const successors = (id: EntityId): readonly EntityId[] =>
    folded.outgoing(id).map((edge) => edge.to);
  for (const component of stronglyConnectedComponents(nodeIds, successors)) {
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
    const feedbackEdges = feedbackArcSet(edges);
    const feedbackWeight = feedbackEdges.reduce((sum, edge) => sum + edge.count, 0);
    const cyclicWeight = edges.reduce(
      (sum, edge) => (edge.selfLoop ? sum : sum + edge.count),
      0,
    );
    return {
      members,
      size: members.length,
      internalEdgeCount: edges.length,
      weight: weights[position] ?? 0,
      edges,
      feedbackEdges,
      feedbackWeight,
      tangleMetric: cyclicWeight === 0 ? 0 : feedbackWeight / cyclicWeight,
    };
  });

  return {
    level: folded.level,
    view: folded.view,
    components,
    selfLoops: sortedUnique(selfLooping),
    tangle: tangleSummary(components),
  };
}

function tangleSummary(components: readonly StronglyConnectedComponent[]): TangleSummary {
  let feedbackEdgeCount = 0;
  let feedbackWeight = 0;
  let cyclicWeight = 0;
  for (const component of components) {
    feedbackEdgeCount += component.feedbackEdges.length;
    feedbackWeight += component.feedbackWeight;
    for (const edge of component.edges) if (!edge.selfLoop) cyclicWeight += edge.count;
  }
  return {
    feedbackEdgeCount,
    feedbackWeight,
    cyclicWeight,
    metric: cyclicWeight === 0 ? 0 : feedbackWeight / cyclicWeight,
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
