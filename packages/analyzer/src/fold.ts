import {
  isStubEntity,
  type EdgeKind,
  type Entity,
  type EntityId,
  type Provenance,
  type TraitName,
} from "@codegraph/core";
import { entityName, hasTrait, type CodeGraph } from "./graph.js";
import { compareIds, sortIds } from "./order.js";
import { identityView, includesEdge, type View, type ViewDescriptor } from "./views.js";

/**
 * Stage 4 of the pipeline: FOLDING — the load-bearing primitive under every
 * query, metric and export (METAMODEL.md §9, decisions 1 and 2).
 *
 * Folding walks the CONTAINMENT chain (`parent`, TChildOf) to the nearest
 * ancestor carrying the level's trait. It never parses an id: `java:a.b/C.m()`
 * looks like it names its package, but that is the extractor's private
 * business (CLAUDE.md invariant 7).
 */

export const FOLD_LEVELS = ["type", "module"] as const;
export type FoldLevel = (typeof FOLD_LEVELS)[number];

const LEVEL_TRAIT: Readonly<Record<FoldLevel, TraitName>> = {
  type: "TType",
  module: "TModule",
};

/** Memoized container lookups for one graph. */
export interface Folder {
  readonly graph: CodeGraph;
  /** Nearest self-or-ancestor with TType, or undefined when there is none. */
  containingType(id: EntityId): EntityId | undefined;
  /** Nearest self-or-ancestor with TModule, or undefined when there is none. */
  containingModule(id: EntityId): EntityId | undefined;
  container(id: EntityId, level: FoldLevel): EntityId | undefined;
}

/**
 * Memoization is not an optimization here: on a 15 000-entity model an
 * unmemoized walk is quadratic. Every node on a resolved path is cached, so
 * the total work is O(V) per level.
 */
export function createFolder(graph: CodeGraph): Folder {
  const caches: Record<FoldLevel, Map<EntityId, EntityId | null>> = {
    type: new Map(),
    module: new Map(),
  };

  const container = (id: EntityId, level: FoldLevel): EntityId | undefined => {
    const cache = caches[level];
    const trait = LEVEL_TRAIT[level];
    const path: EntityId[] = [];
    const seen = new Set<EntityId>();
    let cursor: EntityId | undefined = id;
    let result: EntityId | undefined;

    while (cursor !== undefined) {
      if (cache.has(cursor)) {
        result = cache.get(cursor) ?? undefined;
        break;
      }
      // A malformed parent cycle must not hang the analyzer.
      if (seen.has(cursor)) break;
      seen.add(cursor);

      const entity: Entity | undefined = graph.entity(cursor);
      // A dangling `parent` (reported by load as a closure diagnostic) ends the walk.
      if (entity === undefined) break;
      path.push(cursor);

      if (hasTrait(entity, trait)) {
        result = cursor;
        break;
      }

      const parent: EntityId | undefined = graph.parentOf(cursor);
      if (parent === undefined) {
        // End of the chain with no container found. Leaving `result` undefined
        // is the point: the entity is UNPLACEABLE at this level and is reported
        // as such, never folded onto itself.
        //
        // A stub used to be treated as its own container at every level, on the
        // grounds that its module could not be recovered without parsing its id
        // (forbidden — CLAUDE.md 7). That silently changed the graph's
        // GRANULARITY instead: `java.io/PrintStream`, and even the primitive
        // `int`, became nodes of module dependency graphs, where 88% of the
        // nodes on a real corpus were not modules. The trait check above already
        // folds a stub class onto itself at TYPE level and a stub package at
        // MODULE level, which is every case where self-containment is true; the
        // extractor now supplies `parent` for external types whose package is
        // itself external, so the honest answer is reachable by walking.
        break;
      }
      cursor = parent;
    }

    for (const visited of path) cache.set(visited, result ?? null);
    return result;
  };

  return {
    graph,
    containingType: (id) => container(id, "type"),
    containingModule: (id) => container(id, "module"),
    container,
  };
}

const FOLDERS = new WeakMap<CodeGraph, Folder>();

/** The folder for a graph, created once and reused — memoization must survive. */
export function folderFor(graph: CodeGraph): Folder {
  const existing = FOLDERS.get(graph);
  if (existing !== undefined) return existing;
  const folder = createFolder(graph);
  FOLDERS.set(graph, folder);
  return folder;
}

export function containingType(graph: CodeGraph, id: EntityId): EntityId | undefined {
  return folderFor(graph).containingType(id);
}

export function containingModule(graph: CodeGraph, id: EntityId): EntityId | undefined {
  return folderFor(graph).containingModule(id);
}

/**
 * One aggregated edge between two folded nodes. Folding 24 600 base edges to
 * type level produces many parallel edges between the same pair; collapsing
 * them to a bare pair would discard exactly what makes the result auditable,
 * so the weight and what it aggregated are kept (decision 2).
 */
export interface FoldedEdge {
  readonly from: EntityId;
  readonly to: EntityId;
  /** Number of base edges aggregated into this one. */
  readonly count: number;
  readonly kinds: ReadonlySet<EdgeKind>;
  readonly provenances: ReadonlySet<Provenance>;
  /**
   * True when both endpoints folded onto the same node — a method calling a
   * sibling method of its own class. Legitimate at the fold level, and NOT the
   * forbidden `from === to` of the stored model. Kept and flagged; callers that
   * want a strict dependency graph filter on it.
   */
  readonly selfLoop: boolean;
}

export interface FoldedNode {
  readonly id: EntityId;
  readonly kind: string;
  readonly name: string | undefined;
  readonly isStub: boolean;
  /** How many base entities folded into this node (itself included). */
  readonly members: number;
}

export interface FoldDiagnostics {
  /** Entities with no container at this level, sorted. Excluded from the graph. */
  readonly unfoldableEntities: readonly EntityId[];
  /** Base edges dropped because an endpoint had no container in this view. */
  readonly droppedEdges: number;
  /** Base edges aggregated into `edges`. */
  readonly foldedEdges: number;
}

/** The folded graph: nodes and aggregated edges, both deterministically sorted. */
export interface FoldedGraph {
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  /** Sorted by id. */
  readonly nodes: readonly FoldedNode[];
  /** Sorted by (from, to). */
  readonly edges: readonly FoldedEdge[];
  readonly diagnostics: FoldDiagnostics;

  node(id: EntityId): FoldedNode | undefined;
  /** Derived in memory, like every inverse index (CLAUDE.md invariant 4). */
  outgoing(id: EntityId): readonly FoldedEdge[];
  incoming(id: EntityId): readonly FoldedEdge[];
}

export interface FoldOptions {
  readonly level: FoldLevel;
  /** Defaults to `identityView`. */
  readonly view?: View;
  /** Restrict to these base edge kinds; defaults to all of them. */
  readonly edgeKinds?: readonly EdgeKind[];
  /** Drop folding-induced self-loops entirely. Defaults to false (keep, flagged). */
  readonly dropSelfLoops?: boolean;
}

/**
 * The endpoints are CARRIED here, not recovered by splitting a packed map key:
 * an id is an opaque string that may contain any character (CLAUDE.md invariant
 * 7), so a packed key would make the folded endpoints depend on some separator
 * never occurring inside an id — a silent corruption on the day one does.
 */
interface Accumulator {
  readonly from: EntityId;
  readonly to: EntityId;
  count: number;
  kinds: Set<EdgeKind>;
  provenances: Set<Provenance>;
}

/**
 * Fold the graph to `level` under `view`. Pure: the base model is only read.
 *
 * An entity is foldable only when its container exists AND the view keeps that
 * container — a projection may not contain a node it excludes.
 */
export function foldGraph(graph: CodeGraph, options: FoldOptions): FoldedGraph {
  const view = options.view ?? identityView;
  const level = options.level;
  const folder = folderFor(graph);
  const kinds = options.edgeKinds === undefined ? undefined : new Set<EdgeKind>(options.edgeKinds);

  const containerOf = new Map<EntityId, EntityId>();
  const unfoldable: EntityId[] = [];
  const members = new Map<EntityId, number>();

  for (const id of graph.ids()) {
    const entity = graph.entity(id);
    if (entity === undefined || !view.entity(entity, graph)) continue;
    const container = folder.container(id, level);
    const containerEntity = container === undefined ? undefined : graph.entity(container);
    if (container === undefined || containerEntity === undefined || !view.entity(containerEntity, graph)) {
      unfoldable.push(id);
      continue;
    }
    containerOf.set(id, container);
    members.set(container, (members.get(container) ?? 0) + 1);
  }

  // from -> to -> accumulator: nested, so no id is ever packed into a key.
  const aggregated = new Map<EntityId, Map<EntityId, Accumulator>>();
  let droppedEdges = 0;
  let foldedEdges = 0;

  for (const edge of graph.edges) {
    if (kinds !== undefined && !kinds.has(edge.edge)) continue;
    if (!includesEdge(view, graph, edge)) continue;
    const from = containerOf.get(edge.from);
    const to = containerOf.get(edge.to);
    if (from === undefined || to === undefined) {
      droppedEdges += 1;
      continue;
    }
    if (from === to && options.dropSelfLoops === true) continue;

    let byTarget = aggregated.get(from);
    if (byTarget === undefined) {
      byTarget = new Map<EntityId, Accumulator>();
      aggregated.set(from, byTarget);
    }
    const entry = byTarget.get(to);
    if (entry === undefined) {
      byTarget.set(to, {
        from,
        to,
        count: 1,
        kinds: new Set([edge.edge]),
        provenances: new Set([edge.provenance]),
      });
    } else {
      entry.count += 1;
      entry.kinds.add(edge.edge);
      entry.provenances.add(edge.provenance);
    }
    foldedEdges += 1;
  }

  const nodes: FoldedNode[] = sortIds(members.keys()).map((id) => {
    const entity = graph.entity(id);
    return {
      id,
      kind: entity?.kind ?? "unknown",
      name: entity === undefined ? undefined : entityName(entity),
      isStub: entity !== undefined && isStubEntity(entity),
      members: members.get(id) ?? 0,
    };
  });

  const edges: FoldedEdge[] = [];
  for (const byTarget of aggregated.values()) {
    for (const entry of byTarget.values()) {
      edges.push({
        from: entry.from,
        to: entry.to,
        count: entry.count,
        kinds: entry.kinds as ReadonlySet<EdgeKind>,
        provenances: entry.provenances as ReadonlySet<Provenance>,
        selfLoop: entry.from === entry.to,
      });
    }
  }
  edges.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));

  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<EntityId, FoldedEdge[]>();
  const incoming = new Map<EntityId, FoldedEdge[]>();
  for (const edge of edges) {
    const out = outgoing.get(edge.from);
    if (out === undefined) outgoing.set(edge.from, [edge]);
    else out.push(edge);
    const inc = incoming.get(edge.to);
    if (inc === undefined) incoming.set(edge.to, [edge]);
    else inc.push(edge);
  }

  const empty: readonly FoldedEdge[] = Object.freeze([]);
  return {
    level,
    view: view.descriptor,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    diagnostics: {
      unfoldableEntities: Object.freeze(sortIds(unfoldable)),
      droppedEdges,
      foldedEdges,
    },
    node: (id) => byId.get(id),
    outgoing: (id) => outgoing.get(id) ?? empty,
    incoming: (id) => incoming.get(id) ?? empty,
  };
}
