import { isStubEntity, type Edge, type Entity, type Provenance } from "@codegraph/core";
import type { CodeGraph } from "./graph.js";
import { compareIds } from "./order.js";

/**
 * Stage 3 of the pipeline: views.
 *
 * A view is a PREDICATE PAIR, not a copy (decision 3). Building one allocates
 * nothing but the pair; it never mutates or clones the base model. Views
 * compose, and every result computed under one carries its descriptor, because
 * a coupling number without its view is not a fact (decision 4).
 */

export type EntityPredicate = (entity: Entity, graph: CodeGraph) => boolean;
export type EdgePredicate = (edge: Edge, graph: CodeGraph) => boolean;

/** What a view IS, in a form a report, a CSV header or a DOT comment can state. */
export interface ViewDescriptor {
  /** `all`, `internalOnly`, `internalOnly+declaredOnly`, … */
  readonly name: string;
  /** The composed filters, in composition order. */
  readonly filters: readonly string[];
}

export interface View {
  readonly descriptor: ViewDescriptor;
  readonly entity: EntityPredicate;
  readonly edge: EdgePredicate;
}

function descriptorFor(filters: readonly string[]): ViewDescriptor {
  return { name: filters.length === 0 ? "all" : filters.join("+"), filters };
}

/** Build a named view from its predicates. */
export function makeView(name: string, entity: EntityPredicate, edge: EdgePredicate): View {
  return { descriptor: descriptorFor([name]), entity, edge };
}

/** The base view: everything the model declares, stubs and inferences included. */
export const identityView: View = {
  descriptor: descriptorFor([]),
  entity: () => true,
  edge: () => true,
};

/**
 * Internal-only (METAMODEL.md §9): drop `isStub` entities and every edge that
 * touches one. Membership is decided by the entity's own `isStub` flag — a
 * corpus-declared whitelist — never by an id or package prefix (CLAUDE.md
 * invariant 6): Spoon in noClasspath mode invents plausible FQNs.
 */
export const internalOnly: View = makeView(
  "internalOnly",
  (entity) => !isStubEntity(entity),
  (edge, graph) => !graph.isStub(edge.from) && !graph.isStub(edge.to),
);

/** Keep only the edges whose provenance is in `provenances`. Entities untouched. */
export function provenanceOnly(...provenances: readonly Provenance[]): View {
  const kept = new Set<string>(provenances);
  const name = `provenance:${[...provenances].sort(compareIds).join(",")}`;
  return makeView(
    name,
    () => true,
    (edge) => kept.has(edge.provenance),
  );
}

/**
 * Facts-only (CLAUDE.md invariant 2): `declared` edges and nothing else. An
 * analysis that must not mix facts with inferences composes this in — e.g. the
 * Java module→module import edge is `derived`, and disappears here.
 */
export const declaredOnly: View = makeView(
  "declaredOnly",
  () => true,
  (edge) => edge.provenance === "declared",
);

/** Conjunction of views; the descriptor records the whole composition trail. */
export function composeViews(...views: readonly View[]): View {
  const filters: string[] = [];
  for (const view of views) {
    for (const filter of view.descriptor.filters) {
      if (!filters.includes(filter)) filters.push(filter);
    }
  }
  return {
    descriptor: descriptorFor(filters),
    entity: (entity, graph) => views.every((view) => view.entity(entity, graph)),
    edge: (edge, graph) => views.every((view) => view.edge(edge, graph)),
  };
}

/** Does the view keep this entity? */
export function includesEntity(view: View, graph: CodeGraph, entity: Entity): boolean {
  return view.entity(entity, graph);
}

/**
 * Does the view keep this edge? Both endpoints must survive the ENTITY filter
 * too: a projection may not contain an edge to a node it excludes, and an edge
 * whose endpoint the graph never declares (a dangling reference, reported at
 * load) is not projectable either.
 */
export function includesEdge(view: View, graph: CodeGraph, edge: Edge): boolean {
  if (!view.edge(edge, graph)) return false;
  const from = graph.entity(edge.from);
  const to = graph.entity(edge.to);
  if (from === undefined || to === undefined) return false;
  return view.entity(from, graph) && view.entity(to, graph);
}

/** A view materialized as arrays — a projection over the base, never a clone. */
export interface Projection {
  readonly view: ViewDescriptor;
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
}

export function projectView(graph: CodeGraph, view: View = identityView): Projection {
  const entities = graph
    .ids()
    .map((id) => graph.entity(id))
    .filter((entity): entity is Entity => entity !== undefined && view.entity(entity, graph));
  const edges = graph.edges.filter((edge) => includesEdge(view, graph, edge));
  return { view: view.descriptor, entities, edges };
}
