import type { EdgeKind, EntityId, Provenance } from "@codegraph/core";
import type { FoldedEdge, FoldedGraph, FoldedNode, FoldLevel } from "../src/fold.js";
import type { CouplingRow, CouplingTable } from "../src/metrics/coupling.js";
import type {
  CycleEdge,
  CycleReport,
  StronglyConnectedComponent,
} from "../src/metrics/cycles.js";
import { compareIds } from "../src/order.js";
import type { ViewDescriptor } from "../src/views.js";

/**
 * Hand-built analysis artefacts for the export tests.
 *
 * The metric slices land in other worktrees, so these tests must not call
 * `coupling()` or `cycles()` — and should not: an export is a rendering of a
 * table, and its contract is the table shape, not how the numbers were reached.
 * `FoldedGraph`s that the fixture cannot produce (adversarial ids, an edge
 * pointing at an undeclared node) are built here too.
 */

const VIEW: ViewDescriptor = { name: "all", filters: [] };

export function foldedNode(id: EntityId, overrides: Partial<FoldedNode> = {}): FoldedNode {
  return { id, kind: "class", name: id, isStub: false, members: 1, ...overrides };
}

export function foldedEdge(
  from: EntityId,
  to: EntityId,
  overrides: Partial<Omit<FoldedEdge, "from" | "to">> = {},
): FoldedEdge {
  const kinds = overrides.kinds ?? new Set<EdgeKind>(["invocation"]);
  const provenances = overrides.provenances ?? new Set<Provenance>(["declared"]);
  return {
    from,
    to,
    count: overrides.count ?? 1,
    kinds,
    provenances,
    selfLoop: overrides.selfLoop ?? from === to,
  };
}

/** A FoldedGraph literal with the same derived indexes `foldGraph` builds. */
export function makeFolded(
  nodes: readonly FoldedNode[],
  edges: readonly FoldedEdge[],
  level: FoldLevel = "type",
  view: ViewDescriptor = VIEW,
): FoldedGraph {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<EntityId, FoldedEdge[]>();
  const incoming = new Map<EntityId, FoldedEdge[]>();
  const push = (index: Map<EntityId, FoldedEdge[]>, key: EntityId, edge: FoldedEdge): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [edge]);
    else bucket.push(edge);
  };
  for (const edge of edges) {
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }
  const empty: readonly FoldedEdge[] = Object.freeze([]);
  return {
    level,
    view,
    nodes: [...nodes].sort((a, b) => compareIds(a.id, b.id)),
    edges: [...edges].sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to)),
    diagnostics: { unfoldableEntities: [], droppedEdges: 0, foldedEdges: edges.length },
    node: (id) => byId.get(id),
    outgoing: (id) => outgoing.get(id) ?? empty,
    incoming: (id) => incoming.get(id) ?? empty,
  };
}

/** Ids that a real corpus can produce, plus the three that break naive quoting. */
export const ADVERSARIAL_IDS = {
  signature: 'java:com.acme/Order#pay(java.util.List<java.lang.String>,int[],Foo$Bar)',
  quote: 'java:com.acme/Weird#say("hi")',
  backslash: "java:com.acme/Weird#path\\to\\thing",
  newline: "java:com.acme/Weird#line1\nline2",
  tab: "java:com.acme/Weird#col1\tcol2",
} as const;

export function couplingRow(id: EntityId, overrides: Partial<CouplingRow> = {}): CouplingRow {
  const fanOut = overrides.fanOut ?? 0;
  const fanIn = overrides.fanIn ?? 0;
  return {
    id,
    name: id,
    isStub: false,
    fanOut,
    fanIn,
    ce: overrides.ce ?? fanOut,
    ca: overrides.ca ?? fanIn,
    instability: overrides.instability ?? (fanIn + fanOut === 0 ? 0 : fanOut / (fanIn + fanOut)),
    outgoingEdgeCount: overrides.outgoingEdgeCount ?? 0,
    incomingEdgeCount: overrides.incomingEdgeCount ?? 0,
    ...overrides,
  };
}

export function couplingTable(
  rows: readonly CouplingRow[],
  level: FoldLevel = "type",
  view: ViewDescriptor = VIEW,
): CouplingTable {
  return { level, view, rows };
}

export function scc(
  members: readonly EntityId[],
  internalEdgeCount: number,
  weight: number,
  edges: readonly CycleEdge[] = [],
  feedbackEdges: readonly CycleEdge[] = [],
): StronglyConnectedComponent {
  // Derived the way cycles() derives them, from hand-built inputs: the metric
  // divides non-self weight only, and an absent denominator yields 0, not NaN.
  const feedbackWeight = feedbackEdges.reduce((sum, edge) => sum + edge.count, 0);
  const cyclicWeight = edges.reduce((sum, edge) => (edge.selfLoop ? sum : sum + edge.count), 0);
  return {
    members,
    size: members.length,
    internalEdgeCount,
    weight,
    edges,
    feedbackEdges,
    feedbackWeight,
    tangleMetric: cyclicWeight === 0 ? 0 : feedbackWeight / cyclicWeight,
  };
}

/** A CycleEdge as `cycles()` builds them: sets already flattened to sorted arrays. */
export function cycleEdge(
  from: EntityId,
  to: EntityId,
  overrides: Partial<Omit<CycleEdge, "from" | "to">> = {},
): CycleEdge {
  const kinds = overrides.kinds ?? (["invocation"] as const);
  const provenances = overrides.provenances ?? (["declared"] as const);
  return {
    from,
    to,
    count: overrides.count ?? 1,
    kinds: [...kinds],
    provenances: [...provenances],
    allDeclared: overrides.allDeclared ?? provenances.every((p) => p === "declared"),
    selfLoop: overrides.selfLoop ?? from === to,
  };
}

export function cycleReport(
  components: readonly StronglyConnectedComponent[],
  selfLoops: readonly EntityId[] = [],
  level: FoldLevel = "type",
  view: ViewDescriptor = VIEW,
): CycleReport {
  let feedbackEdgeCount = 0;
  let feedbackWeight = 0;
  let cyclicWeight = 0;
  for (const component of components) {
    feedbackEdgeCount += component.feedbackEdges.length;
    feedbackWeight += component.feedbackWeight;
    for (const edge of component.edges) if (!edge.selfLoop) cyclicWeight += edge.count;
  }
  return {
    level,
    view,
    components,
    selfLoops,
    tangle: {
      feedbackEdgeCount,
      feedbackWeight,
      cyclicWeight,
      metric: cyclicWeight === 0 ? 0 : feedbackWeight / cyclicWeight,
    },
  };
}
