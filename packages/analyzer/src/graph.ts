import {
  isStubEntity,
  type Edge,
  type EdgeKind,
  type Entity,
  type EntityId,
  type TraitName,
} from "@codegraph/core";
import type { ModelUnion } from "./load.js";
import { compareIds, sortIds } from "./order.js";

/**
 * Stage 2 of the pipeline (PLAN.md §6.2): the indexed model.
 *
 * The graph OWNS no data — it holds the union's entities and edges by
 * reference and never writes into them. Analysis is pure computation.
 */

const EMPTY: readonly never[] = Object.freeze([]);

/** Trait-contributed keys, read through one place so nothing parses an id. */
export function entityParent(entity: Entity): EntityId | undefined {
  const value = (entity as Record<string, unknown>)["parent"];
  return typeof value === "string" ? value : undefined;
}

export function entityName(entity: Entity): string | undefined {
  const value = (entity as Record<string, unknown>)["name"];
  return typeof value === "string" ? value : undefined;
}

export function hasTrait(entity: Entity, trait: TraitName): boolean {
  return entity.traits.includes(trait);
}

/**
 * The indexed model. Every accessor returns frozen, deterministically ordered
 * data; nothing here exposes a mutable internal.
 */
export interface CodeGraph {
  readonly union: ModelUnion;
  /** First declaration wins for a redeclared id (see `LoadDiagnostics.duplicateIds`). */
  readonly entities: ReadonlyMap<EntityId, Entity>;
  readonly edges: readonly Edge[];

  entity(id: EntityId): Entity | undefined;
  has(id: EntityId): boolean;
  /** All declared ids, sorted. */
  ids(): readonly EntityId[];
  isStub(id: EntityId): boolean;

  outgoing(id: EntityId): readonly Edge[];
  incoming(id: EntityId): readonly Edge[];
  outgoingOfKind(id: EntityId, kind: EdgeKind): readonly Edge[];
  incomingOfKind(id: EntityId, kind: EdgeKind): readonly Edge[];

  /** Containment as written (TChildOf). Attachment is a different relation. */
  parentOf(id: EntityId): EntityId | undefined;
  /** Derived inverse of `parent`, sorted. */
  childrenOf(id: EntityId): readonly EntityId[];

  callersOf(id: EntityId): readonly EntityId[];
  accessorsOf(id: EntityId): readonly EntityId[];
  subtypesOf(id: EntityId): readonly EntityId[];
  implementersOf(id: EntityId): readonly EntityId[];
  importersOf(id: EntityId): readonly EntityId[];
}

type IdIndex = Map<EntityId, readonly EntityId[]>;

function push<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [value]);
  else bucket.push(value);
}

function addDistinct(index: Map<EntityId, Set<EntityId>>, key: EntityId, value: EntityId): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, new Set([value]));
  else bucket.add(value);
}

/** Sets → sorted frozen arrays, once, at the end of the build (decision 6). */
function finalize(index: Map<EntityId, Set<EntityId>>): IdIndex {
  const out: IdIndex = new Map();
  for (const [key, values] of index) out.set(key, Object.freeze(sortIds(values)));
  return out;
}

/**
 * Build the indexed graph in ONE pass over the entities and ONE over the edges
 * — O(V+E) — rather than scanning per query.
 */
export function buildGraph(union: ModelUnion): CodeGraph {
  const entities = new Map<EntityId, Entity>();
  for (const entity of union.entities) {
    if (!entities.has(entity.id)) entities.set(entity.id, entity);
  }

  const parents = new Map<EntityId, EntityId>();
  const childrenRaw = new Map<EntityId, Set<EntityId>>();
  for (const entity of entities.values()) {
    const parent = entityParent(entity);
    if (parent === undefined) continue;
    parents.set(entity.id, parent);
    addDistinct(childrenRaw, parent, entity.id);
  }

  const outgoingRaw = new Map<EntityId, Edge[]>();
  const incomingRaw = new Map<EntityId, Edge[]>();

  // ------------------------------------------------------------------
  // DERIVED INVERSE INDEXES (CLAUDE.md invariant 4, METAMODEL.md §9).
  // The model stores OUTGOING edges only. Everything below — callers,
  // accessors, subtypes, implementers, importers, children — is derived here,
  // in memory, on every run. None of it may EVER be serialized: if one of
  // these maps can reach a file on disk, that is a bug, not an optimization.
  // ------------------------------------------------------------------
  const callers = new Map<EntityId, Set<EntityId>>();
  const accessors = new Map<EntityId, Set<EntityId>>();
  const subtypes = new Map<EntityId, Set<EntityId>>();
  const implementers = new Map<EntityId, Set<EntityId>>();
  const importers = new Map<EntityId, Set<EntityId>>();

  for (const edge of union.edges) {
    push(outgoingRaw, edge.from, edge);
    push(incomingRaw, edge.to, edge);
    switch (edge.edge) {
      case "invocation":
        addDistinct(callers, edge.to, edge.from);
        break;
      case "access":
        addDistinct(accessors, edge.to, edge.from);
        break;
      case "inheritance":
        addDistinct(subtypes, edge.to, edge.from);
        break;
      case "interfaceImplementation":
        addDistinct(implementers, edge.to, edge.from);
        break;
      case "import":
        addDistinct(importers, edge.to, edge.from);
        break;
      default:
        break;
    }
  }

  const outgoing = new Map<EntityId, readonly Edge[]>();
  for (const [id, list] of outgoingRaw) outgoing.set(id, Object.freeze(list));
  const incoming = new Map<EntityId, readonly Edge[]>();
  for (const [id, list] of incomingRaw) incoming.set(id, Object.freeze(list));

  const children = finalize(childrenRaw);
  const callersIndex = finalize(callers);
  const accessorsIndex = finalize(accessors);
  const subtypesIndex = finalize(subtypes);
  const implementersIndex = finalize(implementers);
  const importersIndex = finalize(importers);

  const sortedIds = Object.freeze(sortIds(entities.keys()));

  const byKind = (list: readonly Edge[], kind: EdgeKind): readonly Edge[] =>
    Object.freeze(list.filter((edge) => edge.edge === kind));

  return {
    union,
    entities,
    edges: union.edges,
    entity: (id) => entities.get(id),
    has: (id) => entities.has(id),
    ids: () => sortedIds,
    isStub: (id) => {
      const entity = entities.get(id);
      return entity !== undefined && isStubEntity(entity);
    },
    outgoing: (id) => outgoing.get(id) ?? EMPTY,
    incoming: (id) => incoming.get(id) ?? EMPTY,
    outgoingOfKind: (id, kind) => byKind(outgoing.get(id) ?? EMPTY, kind),
    incomingOfKind: (id, kind) => byKind(incoming.get(id) ?? EMPTY, kind),
    parentOf: (id) => parents.get(id),
    childrenOf: (id) => children.get(id) ?? EMPTY,
    callersOf: (id) => callersIndex.get(id) ?? EMPTY,
    accessorsOf: (id) => accessorsIndex.get(id) ?? EMPTY,
    subtypesOf: (id) => subtypesIndex.get(id) ?? EMPTY,
    implementersOf: (id) => implementersIndex.get(id) ?? EMPTY,
    importersOf: (id) => importersIndex.get(id) ?? EMPTY,
  };
}

/** Entities the graph declares, in sorted id order — a stable iteration base. */
export function sortedEntities(graph: CodeGraph): readonly Entity[] {
  return graph
    .ids()
    .map((id) => graph.entity(id))
    .filter((entity): entity is Entity => entity !== undefined);
}

/** Stable order for edges: (from, to, kind, provenance). Used by every export. */
export function compareEdges(a: Edge, b: Edge): number {
  return (
    compareIds(a.from, b.from) ||
    compareIds(a.to, b.to) ||
    compareIds(a.edge, b.edge) ||
    compareIds(a.provenance, b.provenance)
  );
}
