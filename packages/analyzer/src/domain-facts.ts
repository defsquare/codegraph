import type {
  EntityId,
  Literal,
  NamedArgument,
  Provenance,
  SourceAnchor,
} from "@codegraph/core";
import { containingModule, containingType, folderFor } from "./fold.js";
import { entityName, hasTrait, type CodeGraph } from "./graph.js";
import { compareIds } from "./order.js";
import { importGraph } from "./queries.js";
import { identityView, includesEdge, type View, type ViewDescriptor } from "./views.js";
import { ARTEFACT_GENERATOR } from "./exports/json.js";
import { deriveFrameworkWiring, type InjectionPoint, type WiringDiagnostics } from "./framework/wiring.js";
import type { FrameworkProfile } from "./framework/profile.js";

/**
 * DOMAIN FACTS (METAMODEL §9): the per-type dossier a domain-extraction
 * consumer reads instead of the raw model. Everything here is a JOIN of facts
 * the model already carries — annotation uses with their arguments (§1.6),
 * outgoing invocations/accesses/throws with their anchors, declared-type
 * lookups, framework roles and injection points (§9.1), and the module import
 * summary — so a consumer deciding "is this operation a command handler?" or
 * "is this field a status?" reads one record instead of chasing edges.
 *
 * THE ARTIFACT INTERPRETS NOTHING. A field's declared type KIND is carried
 * (`enum`), never turned into "this is a state machine"; an external target is
 * flagged, never dropped; provenance rides on every joined fact. The one
 * inference layer — framework stereotypes, entry points, DI candidates — is
 * opt-in via a framework profile and labelled as such, exactly as
 * `deriveFrameworkWiring` produced it.
 *
 * This is an ANALYSIS ARTEFACT, not a model (see exports/json.ts): it carries
 * a `kind` and `generatedBy`, no `schemaVersion`, and is never read back by
 * `parseModel`.
 */

export const DOMAIN_FACTS_ARTIFACT_KIND = "codegraph.domainFacts/1";

/** One written annotation on one entity, with everything the model knows. */
export interface AnnotationFact {
  /** The annotation type — normally a stub (its jar is absent). */
  readonly annotation: EntityId;
  /** Its simple name, when the model carries one. */
  readonly name?: string;
  /** The declaring module's name — what a framework table matches on. */
  readonly module?: string;
  readonly arguments: readonly NamedArgument[];
  readonly anchor: SourceAnchor;
}

/** One outgoing call of an operation, joined to its target's type. */
export interface InvocationFact {
  readonly to: EntityId;
  /** The target's containing type (the target itself when it IS a type). */
  readonly targetType?: EntityId;
  readonly targetTypeName?: string;
  /** The framework's word for the target's type, when a profile classified it. */
  readonly targetStereotype?: string;
  /** True when the target (or its type) is external to the corpus. */
  readonly external: boolean;
  readonly provenance: Provenance;
  readonly anchor: SourceAnchor;
}

/** One field/variable read or write, joined to the owning type. */
export interface AccessFact {
  readonly to: EntityId;
  /** The accessed structural entity's name. */
  readonly field?: string;
  /** The type that declares it. */
  readonly ownerType?: EntityId;
  readonly ownerTypeName?: string;
  readonly isRead: boolean;
  readonly isWrite: boolean;
  readonly external: boolean;
  readonly provenance: Provenance;
  readonly anchor: SourceAnchor;
}

/** One written `throw` site: the operation exits with this exception type. */
export interface ThrowFact {
  readonly to: EntityId;
  readonly name?: string;
  readonly external: boolean;
  readonly provenance: Provenance;
  readonly anchor: SourceAnchor;
}

export interface SupertypeFact {
  readonly to: EntityId;
  readonly name?: string;
  readonly relation: "inheritance" | "interfaceImplementation";
  readonly external: boolean;
  readonly provenance: Provenance;
}

export interface FieldFact {
  readonly id: EntityId;
  readonly kind: string;
  readonly name?: string;
  readonly declaredType?: EntityId;
  readonly declaredTypeName?: string;
  /** The declared type's profile kind (`enum`, `class`, …) — carried, not interpreted. */
  readonly declaredTypeKind?: string;
  readonly declaredTypeExternal?: boolean;
  readonly annotations: readonly AnnotationFact[];
  /** The declaration-site constant value (§1.6), when the model carries one. */
  readonly value?: Literal;
  readonly anchor?: SourceAnchor;
}

export interface OperationFact {
  readonly id: EntityId;
  readonly kind: string;
  readonly name?: string;
  readonly signature?: string;
  readonly anchor?: SourceAnchor;
  /** Gross span length — derived from the anchor, the city's `loc`. */
  readonly loc?: number;
  /** A framework entry-point annotation sits on it (nothing in the corpus calls it). */
  readonly entryPoint: boolean;
  readonly annotations: readonly AnnotationFact[];
  /** The extractor's measures (§3.8), unmodified. Absent means "not measured". */
  readonly metrics?: Record<string, number>;
  /** Includes facts from nested lambdas/blocks — anchored where they occurred. */
  readonly invocations: readonly InvocationFact[];
  readonly accesses: readonly AccessFact[];
  readonly throws: readonly ThrowFact[];
}

export interface TypeDossier {
  readonly id: EntityId;
  readonly kind: string;
  readonly name?: string;
  /** The containing module. */
  readonly module?: EntityId;
  readonly anchor?: SourceAnchor;
  readonly loc?: number;
  /** The framework's own word for what the type is FOR, when a profile said so. */
  readonly stereotype?: string;
  readonly annotations: readonly AnnotationFact[];
  readonly supertypes: readonly SupertypeFact[];
  readonly metrics?: Record<string, number>;
  readonly fields: readonly FieldFact[];
  readonly operations: readonly OperationFact[];
  /** Where the container hands dependencies in, with the corpus candidates. */
  readonly injectionPoints: readonly InjectionPoint[];
}

export interface ModuleImportFact {
  readonly to: EntityId;
  readonly name?: string;
  /** Base import edges folded into this one. */
  readonly count: number;
  readonly external: boolean;
}

export interface ModuleFact {
  readonly id: EntityId;
  readonly name?: string;
  /** The dossier types this module contains, sorted. */
  readonly types: readonly EntityId[];
  readonly imports: readonly ModuleImportFact[];
}

export interface DomainFactsDiagnostics {
  readonly types: number;
  readonly operations: number;
  readonly invocations: number;
  readonly accesses: number;
  readonly throwSites: number;
  readonly wiring?: WiringDiagnostics;
}

export interface DomainFacts {
  /** Always `codegraph.domainFacts/1` — analysis output, not a model. */
  readonly kind: string;
  /** Always `@codegraph/analyzer`. */
  readonly generatedBy: string;
  readonly view: ViewDescriptor;
  /** Distinct `lang` values in the union, sorted. */
  readonly langs: readonly string[];
  /** The framework profile applied, when one was. */
  readonly framework?: string;
  /** Sorted by id. */
  readonly modules: readonly ModuleFact[];
  /** Sorted by id. */
  readonly types: readonly TypeDossier[];
  readonly diagnostics: DomainFactsDiagnostics;
}

export interface DomainFactsOptions {
  /** Defaults to `identityView`. */
  readonly view?: View;
  /** Classify types/operations by this framework's vocabulary (§9.1). */
  readonly framework?: FrameworkProfile;
}

/** Anchor-then-target order: facts read in source order, ties broken by id. */
function bySite<T extends { anchor: SourceAnchor; to: EntityId }>(a: T, b: T): number {
  return (
    compareIds(a.anchor.file, b.anchor.file) ||
    a.anchor.span[0] - b.anchor.span[0] ||
    a.anchor.span[1] - b.anchor.span[1] ||
    compareIds(a.to, b.to)
  );
}

function anchorOf(graph: CodeGraph, id: EntityId): SourceAnchor | undefined {
  const value = (graph.entity(id) as Record<string, unknown> | undefined)?.["anchor"];
  return value as SourceAnchor | undefined;
}

function locOf(anchor: SourceAnchor | undefined): number | undefined {
  return anchor === undefined ? undefined : anchor.span[1] - anchor.span[0] + 1;
}

function metricsOf(graph: CodeGraph, id: EntityId): Record<string, number> | undefined {
  const value = (graph.entity(id) as Record<string, unknown> | undefined)?.["metrics"];
  return value as Record<string, number> | undefined;
}

/** Build the domain-facts artifact. Pure: the graph is only read. */
export function buildDomainFacts(
  graph: CodeGraph,
  options: DomainFactsOptions = {},
): DomainFacts {
  const view = options.view ?? identityView;
  const folder = folderFor(graph);

  const wiring =
    options.framework === undefined
      ? undefined
      : deriveFrameworkWiring(graph, options.framework);
  const stereotypeOf = new Map<EntityId, string>();
  const entryPoints = new Set<EntityId>();
  const pointsByConsumer = new Map<EntityId, InjectionPoint[]>();
  for (const role of wiring?.roles ?? []) {
    if (role.role === "stereotype" && role.stereotype !== undefined) {
      // First (sorted) assignment wins for a doubly-stereotyped type.
      if (!stereotypeOf.has(role.id)) stereotypeOf.set(role.id, role.stereotype);
    }
    if (role.role === "entry-point") entryPoints.add(role.id);
  }
  for (const point of wiring?.injectionPoints ?? []) {
    const bucket = pointsByConsumer.get(point.consumer);
    if (bucket === undefined) pointsByConsumer.set(point.consumer, [point]);
    else bucket.push(point);
  }

  const kept = (id: EntityId): boolean => {
    const entity = graph.entity(id);
    return entity !== undefined && view.entity(entity, graph);
  };

  const annotationFactsOf = (id: EntityId): AnnotationFact[] => {
    const facts: AnnotationFact[] = [];
    for (const edge of graph.outgoingOfKind(id, "annotationUse")) {
      if (!includesEdge(view, graph, edge)) continue;
      const target = graph.entity(edge.to);
      const name = target === undefined ? undefined : entityName(target);
      const module = folder.containingModule(edge.to);
      const moduleName =
        module === undefined ? undefined : entityName(graph.entity(module)!);
      facts.push({
        annotation: edge.to,
        ...(name === undefined ? {} : { name }),
        ...(moduleName === undefined ? {} : { module: moduleName }),
        arguments:
          (edge as { arguments?: readonly NamedArgument[] }).arguments ?? [],
        anchor: edge.anchor,
      });
    }
    facts.sort((a, b) =>
      bySite(
        { anchor: a.anchor, to: a.annotation },
        { anchor: b.anchor, to: b.annotation },
      ),
    );
    return facts;
  };

  /**
   * The invocables whose outgoing facts belong to this operation: itself plus
   * every descendant BELOW it that is not a type — a lambda's call is written
   * inside the operation's body, and its anchor says exactly where. A nested
   * TYPE is a dossier of its own, so the walk stops there.
   */
  const factSourcesOf = (operation: EntityId): EntityId[] => {
    const sources: EntityId[] = [];
    const queue: EntityId[] = [operation];
    const seen = new Set<EntityId>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      sources.push(current);
      for (const child of graph.childrenOf(current)) {
        const entity = graph.entity(child);
        if (entity === undefined || hasTrait(entity, "TType")) continue;
        queue.push(child);
      }
    }
    return sources;
  };

  const externalTarget = (to: EntityId, targetType: EntityId | undefined): boolean =>
    graph.isStub(to) || (targetType !== undefined && graph.isStub(targetType));

  let operationCount = 0;
  let invocationCount = 0;
  let accessCount = 0;
  let throwCount = 0;

  const operationFactOf = (id: EntityId): OperationFact => {
    const entity = graph.entity(id)!;
    const invocations: InvocationFact[] = [];
    const accesses: AccessFact[] = [];
    const throws: ThrowFact[] = [];
    for (const source of factSourcesOf(id)) {
      for (const edge of graph.outgoing(source)) {
        if (!includesEdge(view, graph, edge)) continue;
        if (edge.edge === "invocation") {
          const targetType = folder.containingType(edge.to);
          const targetTypeName =
            targetType === undefined ? undefined : entityName(graph.entity(targetType)!);
          const stereotype = targetType === undefined ? undefined : stereotypeOf.get(targetType);
          invocations.push({
            to: edge.to,
            ...(targetType === undefined ? {} : { targetType }),
            ...(targetTypeName === undefined ? {} : { targetTypeName }),
            ...(stereotype === undefined ? {} : { targetStereotype: stereotype }),
            external: externalTarget(edge.to, targetType),
            provenance: edge.provenance,
            anchor: edge.anchor,
          });
        } else if (edge.edge === "access") {
          const target = graph.entity(edge.to);
          const field = target === undefined ? undefined : entityName(target);
          const ownerType = folder.containingType(edge.to);
          const ownerTypeName =
            ownerType === undefined ? undefined : entityName(graph.entity(ownerType)!);
          accesses.push({
            to: edge.to,
            ...(field === undefined ? {} : { field }),
            ...(ownerType === undefined ? {} : { ownerType }),
            ...(ownerTypeName === undefined ? {} : { ownerTypeName }),
            isRead: edge.isRead,
            isWrite: edge.isWrite,
            external: externalTarget(edge.to, ownerType),
            provenance: edge.provenance,
            anchor: edge.anchor,
          });
        } else if (edge.edge === "throws") {
          const target = graph.entity(edge.to);
          const name = target === undefined ? undefined : entityName(target);
          throws.push({
            to: edge.to,
            ...(name === undefined ? {} : { name }),
            external: graph.isStub(edge.to),
            provenance: edge.provenance,
            anchor: edge.anchor,
          });
        }
      }
    }
    invocations.sort(bySite);
    accesses.sort(bySite);
    throws.sort(bySite);
    operationCount += 1;
    invocationCount += invocations.length;
    accessCount += accesses.length;
    throwCount += throws.length;

    const name = entityName(entity);
    const signature = (entity as { signature?: string }).signature;
    const anchor = anchorOf(graph, id);
    const loc = locOf(anchor);
    const metrics = metricsOf(graph, id);
    return {
      id,
      kind: entity.kind,
      ...(name === undefined ? {} : { name }),
      ...(signature === undefined ? {} : { signature }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(loc === undefined ? {} : { loc }),
      entryPoint: entryPoints.has(id),
      annotations: annotationFactsOf(id),
      ...(metrics === undefined ? {} : { metrics }),
      invocations,
      accesses,
      throws,
    };
  };

  const fieldFactOf = (id: EntityId): FieldFact => {
    const entity = graph.entity(id)!;
    const name = entityName(entity);
    const declaredType = (entity as { declaredType?: EntityId }).declaredType;
    const declared = declaredType === undefined ? undefined : graph.entity(declaredType);
    const value = hasTrait(entity, "TWithValue")
      ? (entity as { value?: Literal }).value
      : undefined;
    const anchor = anchorOf(graph, id);
    const declaredName = declared === undefined ? undefined : entityName(declared);
    return {
      id,
      kind: entity.kind,
      ...(name === undefined ? {} : { name }),
      ...(declaredType === undefined ? {} : { declaredType }),
      ...(declaredName === undefined ? {} : { declaredTypeName: declaredName }),
      ...(declared === undefined
        ? {}
        : {
            declaredTypeKind: declared.kind,
            declaredTypeExternal: graph.isStub(declaredType!),
          }),
      annotations: annotationFactsOf(id),
      ...(value === undefined ? {} : { value }),
      ...(anchor === undefined ? {} : { anchor }),
    };
  };

  const typesByModule = new Map<EntityId, EntityId[]>();
  const types: TypeDossier[] = [];

  for (const id of graph.ids()) {
    const entity = graph.entity(id)!;
    if (!hasTrait(entity, "TType") || graph.isStub(id) || !view.entity(entity, graph)) continue;

    const module = folder.containingModule(id);
    if (module !== undefined) {
      const bucket = typesByModule.get(module);
      if (bucket === undefined) typesByModule.set(module, [id]);
      else bucket.push(id);
    }

    const fields: FieldFact[] = [];
    const operations: OperationFact[] = [];
    for (const child of graph.childrenOf(id)) {
      if (!kept(child)) continue;
      const childEntity = graph.entity(child)!;
      if (hasTrait(childEntity, "TInvocable")) operations.push(operationFactOf(child));
      else if (hasTrait(childEntity, "TStructural")) fields.push(fieldFactOf(child));
    }

    const supertypes: SupertypeFact[] = [];
    for (const edge of graph.outgoing(id)) {
      if (edge.edge !== "inheritance" && edge.edge !== "interfaceImplementation") continue;
      if (!includesEdge(view, graph, edge)) continue;
      const name = entityName(graph.entity(edge.to) ?? ({ traits: [] } as never));
      supertypes.push({
        to: edge.to,
        ...(name === undefined ? {} : { name }),
        relation: edge.edge,
        external: graph.isStub(edge.to),
        provenance: edge.provenance,
      });
    }
    supertypes.sort((a, b) => compareIds(a.to, b.to) || compareIds(a.relation, b.relation));

    const name = entityName(entity);
    const anchor = anchorOf(graph, id);
    const loc = locOf(anchor);
    const metrics = metricsOf(graph, id);
    const stereotype = stereotypeOf.get(id);
    types.push({
      id,
      kind: entity.kind,
      ...(name === undefined ? {} : { name }),
      ...(module === undefined ? {} : { module }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(loc === undefined ? {} : { loc }),
      ...(stereotype === undefined ? {} : { stereotype }),
      annotations: annotationFactsOf(id),
      supertypes,
      ...(metrics === undefined ? {} : { metrics }),
      fields,
      operations,
      injectionPoints: pointsByConsumer.get(id) ?? [],
    });
  }

  // The module summary: the bounded-context candidate layer (§9's import graph).
  const imports = importGraph(graph, view);
  const modules: ModuleFact[] = [];
  for (const id of graph.ids()) {
    const entity = graph.entity(id)!;
    if (!hasTrait(entity, "TModule") || graph.isStub(id) || !view.entity(entity, graph)) continue;
    const name = entityName(entity);
    modules.push({
      id,
      ...(name === undefined ? {} : { name }),
      types: typesByModule.get(id) ?? [],
      imports: imports.outgoing(id).map((edge) => {
        const target = imports.node(edge.to);
        return {
          to: edge.to,
          ...(target?.name === undefined ? {} : { name: target.name }),
          count: edge.count,
          external: target?.isStub ?? true,
        };
      }),
    });
  }

  return {
    kind: DOMAIN_FACTS_ARTIFACT_KIND,
    generatedBy: ARTEFACT_GENERATOR,
    view: view.descriptor,
    langs: graph.union.langs,
    ...(options.framework === undefined ? {} : { framework: options.framework.framework }),
    modules,
    types,
    diagnostics: {
      types: types.length,
      operations: operationCount,
      invocations: invocationCount,
      accesses: accessCount,
      throwSites: throwCount,
      ...(wiring === undefined ? {} : { wiring: wiring.diagnostics }),
    },
  };
}

/** Deterministic stringification, newline-terminated (decision 7). */
export function domainFactsToJsonString(facts: DomainFacts): string {
  return `${JSON.stringify(facts, null, 2)}\n`;
}
