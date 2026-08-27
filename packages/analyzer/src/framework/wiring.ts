import type { Edge, EntityId, Entity, NamedArgument, Literal } from "@codegraph/core";
import type { CodeGraph } from "../graph.js";
import { containingModule } from "../fold.js";
import { sortIds } from "../order.js";
import type { AnnotationSpec, FrameworkProfile, FrameworkRole } from "./profile.js";

/**
 * FRAMEWORK SEMANTICS (PLAN §12.4, METAMODEL §9 and §9.1): what the container
 * does to a corpus that the static graph cannot see.
 *
 * Two derivations, both from facts the model already carries — `annotationUse`
 * edges with their arguments (§1.6), and the `interfaceImplementation` inverse
 * index the graph already builds:
 *
 *   ROLES     which types are services, repositories, controllers…; which
 *             methods are entry points nothing in the corpus calls.
 *   WIRING    for each injection point, the corpus implementations the
 *             container could hand in — `dynamic-candidate` edges, in memory
 *             only, because they are guesses about runtime dispatch and
 *             §1.3 says so in as many words.
 *
 * THE FACTS ARE UNTOUCHED. Nothing here rewrites the model or adds to it: a
 * caller that wants facts filters `declared`, and gets byte-identical output
 * whether or not this pass ran.
 */

/** One annotation written on one entity, resolved through the profile. */
export interface AnnotationHit {
  /** The entity carrying the annotation. */
  readonly on: EntityId;
  /** The annotation type — normally a stub (its jar is absent). */
  readonly annotation: EntityId;
  readonly spec: AnnotationSpec;
  readonly arguments: readonly NamedArgument[];
}

/** What the framework says a type or member IS. */
export interface RoleAssignment {
  readonly id: EntityId;
  readonly role: FrameworkRole;
  /** For a stereotype: `service`, `repository`, `controller`, … */
  readonly stereotype?: string;
  /** The annotation that said so — evidence, never a guess from the name. */
  readonly annotation: EntityId;
}

export interface InjectionPoint {
  /** The attribute or parameter the container fills. */
  readonly id: EntityId;
  /** The stereotyped type it belongs to — the consumer of the dependency. */
  readonly consumer: EntityId;
  /** The declared type asked for; absent when the model does not say. */
  readonly declaredType: EntityId | undefined;
  /** How this point was recognized: an annotation, or the framework's own rule. */
  readonly via: "annotation" | "sole-constructor";
  /** `@Qualifier("x")` / `@Named("x")`, when one narrows this point. */
  readonly qualifier?: string;
  /** Corpus implementations the container could supply, sorted. Possibly empty. */
  readonly candidates: readonly EntityId[];
  /** Why the candidate set is empty or narrowed — stated, never silent. */
  readonly note?: string;
}

export interface WiringDiagnostics {
  /** Injection points whose declared type resolves to nothing in the union. */
  readonly unresolvedTypes: number;
  /**
   * Injection points with NO corpus implementation. Not a failure: a Spring
   * Data repository is implemented by the container at runtime, so the empty
   * set is a fact about the corpus.
   */
  readonly unimplemented: number;
  /** Points narrowed from several candidates to one by `@Primary`/`@Qualifier`. */
  readonly narrowed: number;
}

export interface FrameworkWiring {
  readonly framework: string;
  /** Sorted by id. */
  readonly roles: readonly RoleAssignment[];
  /** Sorted by injection-point id. */
  readonly injectionPoints: readonly InjectionPoint[];
  /**
   * One edge per (consumer, candidate) pair: `reference`, provenance
   * `dynamic-candidate`, every edge carrying the WHOLE candidate set. In
   * memory only — never written back into a model (invariant 4).
   */
  readonly edges: readonly Edge[];
  readonly diagnostics: WiringDiagnostics;
}

/** The one place a role is read off an annotation use. */
function annotationHits(graph: CodeGraph, profile: FrameworkProfile): AnnotationHit[] {
  const byKey = new Map<string, AnnotationSpec>();
  for (const spec of profile.annotations) byKey.set(`${spec.module} ${spec.name}`, spec);

  const hits: AnnotationHit[] = [];
  for (const edge of graph.edges) {
    if (edge.edge !== "annotationUse") continue;
    const annotation = graph.entity(edge.to);
    if (annotation === undefined) continue;
    // Name + module, never a parsed id (invariant 7). A stub annotation type
    // carries both — which is the normal case for an absent framework jar.
    const name = (annotation as { name?: string }).name;
    const module = containingModule(graph, edge.to);
    if (name === undefined || module === undefined) continue;
    const spec = byKey.get(`${moduleName(graph, module)} ${name}`);
    if (spec === undefined) continue;
    hits.push({
      on: edge.from,
      annotation: edge.to,
      spec,
      arguments: (edge as unknown as { arguments?: readonly NamedArgument[] }).arguments ?? [],
    });
  }
  return hits;
}

/** A module entity's own name — the dotted package, as the model states it. */
function moduleName(graph: CodeGraph, module: EntityId): string {
  return (graph.entity(module) as { name?: string } | undefined)?.name ?? "";
}

/**
 * Derive what the framework does to this corpus. Pure: reads the graph, writes
 * nothing, and returns edges the CALLER may add to a view — never to a model.
 */
export function deriveFrameworkWiring(
  graph: CodeGraph,
  profile: FrameworkProfile,
): FrameworkWiring {
  const hits = annotationHits(graph, profile);

  const roles: RoleAssignment[] = hits.map((hit) => ({
    id: hit.on,
    role: hit.spec.role,
    ...(hit.spec.stereotype === undefined ? {} : { stereotype: hit.spec.stereotype }),
    annotation: hit.annotation,
  }));
  roles.sort((a, b) => compare(a.id, b.id) || compare(a.role, b.role) || compare(a.annotation, b.annotation));

  const stereotyped = new Set(roles.filter((role) => role.role === "stereotype").map((role) => role.id));
  const primaries = new Set(roles.filter((role) => role.role === "primary").map((role) => role.id));
  const qualifierOf = new Map<EntityId, string>();
  for (const hit of hits) {
    if (hit.spec.role !== "qualifier") continue;
    const value = stringArgument(hit.arguments);
    if (value !== undefined) qualifierOf.set(hit.on, value);
  }
  const injectionAnnotated = new Set(
    hits.filter((hit) => hit.spec.role === "injection-point").map((hit) => hit.on),
  );

  const points = collectInjectionPoints(graph, profile, stereotyped, injectionAnnotated);

  let unresolvedTypes = 0;
  let unimplemented = 0;
  let narrowed = 0;
  const edges: Edge[] = [];
  const resolved: InjectionPoint[] = [];

  for (const point of points) {
    const declaredType = point.declaredType;
    if (declaredType === undefined || !graph.has(declaredType)) {
      unresolvedTypes += 1;
      resolved.push({ ...point, candidates: [], note: "the model does not resolve the declared type" });
      continue;
    }

    // Candidates come straight from the inverse index the graph already has:
    // every CORPUS type that implements the interface asked for. A stub
    // implementation is not a candidate — nothing in this corpus declares it.
    const all = graph.implementersOf(declaredType).filter((id) => !graph.isStub(id));
    const qualifier = qualifierOf.get(point.id);
    const narrowedSet = narrow(graph, all, qualifier, primaries, hits);
    const wasNarrowed = narrowedSet.length !== all.length;
    if (wasNarrowed) narrowed += 1;
    const candidates = sortIds(narrowedSet);
    // Narrowing must never be silent: the alternatives the container did NOT
    // pick are part of what a reader needs to know about this injection.
    const narrowingNote = wasNarrowed
      ? `narrowed by ${qualifier === undefined ? "@Primary" : `@Qualifier("${qualifier}")`} from ` +
        `${all.length} corpus implementations`
      : undefined;

    if (candidates.length === 0) {
      unimplemented += 1;
      resolved.push({
        ...point,
        ...(qualifier === undefined ? {} : { qualifier }),
        candidates,
        note: graph.isStub(declaredType)
          ? "the declared type is external to the corpus"
          : "no corpus type implements it — the container supplies one at runtime",
      });
      continue;
    }

    resolved.push({
      ...point,
      ...(qualifier === undefined ? {} : { qualifier }),
      candidates,
      ...(narrowingNote === undefined ? {} : { note: narrowingNote }),
    });
    for (const candidate of candidates) {
      if (candidate === point.consumer) continue; // a self-edge is not representable
      edges.push({
        edge: "reference",
        from: point.consumer,
        to: candidate,
        provenance: "dynamic-candidate",
        anchor: anchorOf(graph, point.id) ?? anchorOf(graph, point.consumer) ?? FALLBACK_ANCHOR,
        candidates: [...candidates],
      });
    }
  }

  resolved.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));

  return {
    framework: profile.framework,
    roles,
    injectionPoints: resolved,
    edges,
    diagnostics: { unresolvedTypes, unimplemented, narrowed },
  };
}

/**
 * The points the container fills: an annotated field or parameter, and — when
 * the profile says the framework does that — the parameters of the sole
 * constructor of a stereotyped class.
 */
function collectInjectionPoints(
  graph: CodeGraph,
  profile: FrameworkProfile,
  stereotyped: ReadonlySet<EntityId>,
  annotated: ReadonlySet<EntityId>,
): Omit<InjectionPoint, "candidates">[] {
  const points: Omit<InjectionPoint, "candidates">[] = [];
  const seen = new Set<EntityId>();

  const add = (id: EntityId, via: InjectionPoint["via"]): void => {
    if (seen.has(id)) return;
    const entity = graph.entity(id);
    if (entity === undefined) return;
    const consumer = consumerOf(graph, id);
    // Only a stereotyped type is wired: a plain class the container never
    // instantiates has no injection point, whatever it is annotated with.
    if (consumer === undefined || !stereotyped.has(consumer)) return;
    seen.add(id);
    points.push({
      id,
      consumer,
      declaredType: (entity as { declaredType?: EntityId }).declaredType,
      via,
    });
  };

  for (const id of annotated) {
    const entity = graph.entity(id);
    if (entity === undefined) continue;
    // The annotation may sit on the constructor rather than on its parameters;
    // an annotated executable injects through every parameter it declares.
    const parameters = (entity as { parameters?: readonly EntityId[] }).parameters;
    if (parameters !== undefined) for (const parameter of parameters) add(parameter, "annotation");
    else add(id, "annotation");
  }

  if (profile.implicitSoleConstructorInjection) {
    for (const type of stereotyped) {
      const constructors = graph
        .childrenOf(type)
        .filter((id) => graph.entity(id)?.kind === "constructor");
      // SOLE constructor only: with two, the framework needs the annotation to
      // choose, and so do we — guessing would be the container's job, not ours.
      if (constructors.length !== 1) continue;
      const only = constructors[0] as EntityId;
      const parameters = (graph.entity(only) as { parameters?: readonly EntityId[] })?.parameters;
      for (const parameter of parameters ?? []) add(parameter, "sole-constructor");
    }
  }

  return points;
}

/** The stereotyped type an injection point belongs to: its containing TYPE. */
function consumerOf(graph: CodeGraph, id: EntityId): EntityId | undefined {
  let current: EntityId | undefined = graph.parentOf(id);
  for (let guard = 0; guard < 32 && current !== undefined; guard += 1) {
    const entity = graph.entity(current);
    if (entity !== undefined && entity.traits.includes("TType")) return current;
    current = graph.parentOf(current);
  }
  return undefined;
}

/**
 * `@Qualifier("x")` first, `@Primary` second — the framework's own precedence.
 * Both narrow by EXACT match on facts the model carries; neither guesses.
 */
function narrow(
  graph: CodeGraph,
  candidates: readonly EntityId[],
  qualifier: string | undefined,
  primaries: ReadonlySet<EntityId>,
  hits: readonly AnnotationHit[],
): readonly EntityId[] {
  if (candidates.length <= 1) return candidates;

  if (qualifier !== undefined) {
    const named = candidates.filter((id) => beanNamesOf(graph, id, hits).includes(qualifier));
    if (named.length > 0) return named;
  }

  const primary = candidates.filter((id) => primaries.has(id));
  if (primary.length === 1) return primary;

  return candidates;
}

/**
 * The names a bean answers to: the string argument of its stereotype
 * (`@Service("clinic")`), and Spring's default — the decapitalized simple
 * name. Framework knowledge, kept in the framework layer.
 */
function beanNamesOf(graph: CodeGraph, id: EntityId, hits: readonly AnnotationHit[]): string[] {
  const names: string[] = [];
  const simple = (graph.entity(id) as { name?: string } | undefined)?.name;
  if (simple !== undefined && simple.length > 0) {
    names.push(simple[0]!.toLowerCase() + simple.slice(1));
  }
  for (const hit of hits) {
    if (hit.on !== id || hit.spec.role !== "stereotype") continue;
    const value = stringArgument(hit.arguments);
    if (value !== undefined && value.length > 0) names.push(value);
  }
  return names;
}

/** The `value = "…"` of an annotation use, when it wrote a plain string. */
function stringArgument(args: readonly NamedArgument[]): string | undefined {
  for (const argument of args) {
    if (argument.name !== "value") continue;
    const value = argument.value as Literal;
    if (value.k === "string") return value.v;
  }
  return undefined;
}

const FALLBACK_ANCHOR = { file: "(derived)", span: [1, 1] as [number, number] };

function anchorOf(graph: CodeGraph, id: EntityId): Edge["anchor"] | undefined {
  const anchor = (graph.entity(id) as Entity & { anchor?: Edge["anchor"] } | undefined)?.anchor;
  return anchor;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
