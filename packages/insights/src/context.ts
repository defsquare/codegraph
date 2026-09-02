import type { EntityId, Literal, NamedArgument } from "@codegraph/core";
import {
  entityName,
  folderFor,
  hasTrait,
  type AnnotationFact,
  type CodeGraph,
  type DomainFacts,
  type ModuleFact,
  type OperationFact,
  type TypeDossier,
} from "@codegraph/analyzer";
import { digestOf } from "./fingerprint.js";
import type { Unit } from "./order.js";
import type { InsightRecord, Level } from "./schema.js";
import type { SourceReader, SourceSlice } from "./source.js";
import type { UnitSet } from "./units.js";

/**
 * THE CONTEXT PACK: everything one prompt is built from, as data. Source
 * slices from anchors, the Javadoc the model already carries, the dossier's
 * facts (calls, accesses, throws, fields, supertypes, imports, annotations,
 * metrics, framework roles), and — the point of the bottom-up walk — the
 * EXPLANATIONS already produced for what this unit depends on, so the prompt
 * carries a callee's summary instead of its source.
 *
 * Depth: 1 gives each dependency's summary; 2 also nests the dependencies'
 * dependencies' summaries (one line each); deeper repeats the nesting. A
 * dependency with no record yet (out of scope, or failed) is shown as such —
 * a fact the model must not paper over.
 */

export interface DependencySummary {
  readonly id: EntityId;
  readonly level: Level;
  readonly name: string;
  /** The record's `description`; empty when `missing`. */
  readonly summary: string;
  /** The type record's concept / the operation's owner / the module's hint — the Specy word. */
  readonly concept: string | undefined;
  readonly missing: boolean;
  readonly children: readonly DependencySummary[];
}

export interface CallFact {
  readonly target: string;
  readonly targetType: string | undefined;
  readonly stereotype: string | undefined;
  readonly external: boolean;
  readonly provenance: string;
}

export interface AccessSummary {
  readonly field: string;
  readonly ownerType: string | undefined;
  readonly mode: "read" | "write" | "read/write";
  readonly external: boolean;
}

export interface FieldSummary {
  readonly name: string;
  readonly type: string | undefined;
  readonly typeKind: string | undefined;
  readonly external: boolean | undefined;
  readonly value: string | undefined;
  readonly annotations: readonly string[];
}

export interface MemberPack {
  readonly id: EntityId;
  readonly level: Level;
  readonly kind: string;
  readonly name: string;
  readonly signature: string | undefined;
  readonly containingType: string | undefined;
  readonly containingModule: string | undefined;
  readonly comments: readonly string[];
  /** Rendered `@Name(arg = value, …)`. */
  readonly annotations: readonly string[];
  readonly metrics: Readonly<Record<string, number>> | undefined;
  readonly entryPoint: boolean;
  readonly stereotype: string | undefined;
  readonly source: SourceSlice | undefined;
  readonly calls: readonly CallFact[];
  readonly accesses: readonly AccessSummary[];
  readonly throws: readonly { readonly name: string; readonly external: boolean }[];
  readonly fields: readonly FieldSummary[];
  readonly supertypes: readonly { readonly name: string; readonly relation: string; readonly external: boolean }[];
  readonly injectionPoints: readonly { readonly name: string; readonly declaredType: string | undefined; readonly candidates: readonly string[] }[];
  /** Explained parts of this member: a type's operations, a module's types. */
  readonly parts: readonly DependencySummary[];
  readonly imports: readonly { readonly name: string; readonly count: number; readonly external: boolean }[];
}

export interface ContextPack {
  readonly unit: Unit;
  readonly level: Level;
  readonly members: readonly MemberPack[];
  /** Dependencies OTHER than the unit's own parts (calls, type dependencies, imports). */
  readonly dependencies: readonly DependencySummary[];
  readonly depth: number;
  /** Inputs for the fingerprint: texts shown, and a digest of the facts shown. */
  readonly sources: readonly string[];
  readonly comments: readonly string[];
  readonly signatures: readonly string[];
  readonly factsDigest: string;
}

export interface ContextEnv {
  readonly graph: CodeGraph;
  readonly facts: DomainFacts;
  readonly units: UnitSet;
  readonly reader: SourceReader;
  readonly records: ReadonlyMap<EntityId, InsightRecord>;
  readonly unitOf: ReadonlyMap<EntityId, Unit>;
  readonly depth: number;
  readonly maxLines: number;
}

function displayName(graph: CodeGraph, id: EntityId): string {
  const entity = graph.entity(id);
  return (entity === undefined ? undefined : entityName(entity)) ?? id;
}

export function renderLiteral(value: Literal): string {
  switch (value.k) {
    case "string":
      return JSON.stringify(value.v);
    case "number":
      return value.v;
    case "boolean":
      return String(value.v);
    case "null":
      return "null";
    case "enum":
      return `${value.type.slice(value.type.lastIndexOf("/") + 1)}.${value.name}`;
    case "type":
      return `${value.type.slice(value.type.lastIndexOf("/") + 1)}.class`;
    case "array":
      return `[${value.items.map(renderLiteral).join(", ")}]`;
    case "annotation":
      return `@${value.type.slice(value.type.lastIndexOf("/") + 1)}(${renderArguments(value.arguments)})`;
    case "unevaluated":
      return value.source;
  }
}

function renderArguments(args: readonly NamedArgument[]): string {
  return args.map((a) => `${a.name} = ${renderLiteral(a.value)}`).join(", ");
}

export function renderAnnotation(fact: AnnotationFact): string {
  const name = fact.name ?? fact.annotation.slice(fact.annotation.lastIndexOf("/") + 1);
  return fact.arguments.length === 0 ? `@${name}` : `@${name}(${renderArguments(fact.arguments)})`;
}

function conceptOf(record: InsightRecord): string | undefined {
  switch (record.level) {
    case "operation":
      return record.block.owner === "unknown" ? undefined : `owned by ${record.block.owner}`;
    case "type":
      return record.block.concept;
    case "module":
      return record.block.boundedContextHint?.name === undefined ? undefined : `context: ${record.block.boundedContextHint.name}`;
  }
}

/** The summaries of one unit's members, nested to `depth` through the unit graph. */
function summariesOf(env: ContextEnv, unit: Unit, depth: number, seen: ReadonlySet<string>): DependencySummary[] {
  const nextSeen = new Set(seen).add(unit.id);
  const children =
    depth > 1
      ? unit.deps.filter((d) => !nextSeen.has(d)).flatMap((d) => {
          const dep = env.unitOf.get(d);
          return dep === undefined ? [] : summariesOf(env, dep, depth - 1, nextSeen);
        })
      : [];
  return unit.members.map((id) => {
    const record = env.records.get(id);
    return {
      id,
      level: unit.level,
      name: displayName(env.graph, id),
      summary: record?.block.description ?? "",
      concept: record === undefined ? undefined : conceptOf(record),
      missing: record === undefined,
      children,
    };
  });
}

function commentsOf(graph: CodeGraph, id: EntityId): readonly string[] {
  const entity = graph.entity(id);
  if (entity === undefined || !hasTrait(entity, "TComment")) return [];
  const value = (entity as Record<string, unknown>)["comments"];
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
}

function operationPack(env: ContextEnv, id: EntityId, fact: OperationFact, dossier: TypeDossier): MemberPack {
  const folder = folderFor(env.graph);
  const module = folder.containingModule(id);
  return {
    id,
    level: "operation",
    kind: fact.kind,
    name: fact.name ?? (fact.kind === "constructor" ? `${dossier.name ?? "constructor"}` : id),
    signature: fact.signature,
    containingType: dossier.name ?? dossier.id,
    containingModule: module === undefined ? undefined : displayName(env.graph, module),
    comments: commentsOf(env.graph, id),
    annotations: fact.annotations.map(renderAnnotation),
    metrics: fact.metrics,
    entryPoint: fact.entryPoint,
    stereotype: undefined,
    source: fact.anchor === undefined ? undefined : env.reader.slice(fact.anchor, env.maxLines),
    calls: fact.invocations.map((c) => ({
      target: displayName(env.graph, c.to),
      targetType: c.targetTypeName ?? (c.targetType === undefined ? undefined : displayName(env.graph, c.targetType)),
      stereotype: c.targetStereotype,
      external: c.external,
      provenance: c.provenance,
    })),
    accesses: fact.accesses.map((a) => ({
      field: a.field ?? a.to,
      ownerType: a.ownerTypeName,
      mode: a.isRead && a.isWrite ? "read/write" : a.isWrite ? "write" : "read",
      external: a.external,
    })),
    throws: fact.throws.map((t) => ({ name: t.name ?? t.to, external: t.external })),
    fields: [],
    supertypes: [],
    injectionPoints: [],
    parts: [],
    imports: [],
  };
}

function typePack(env: ContextEnv, dossier: TypeDossier): MemberPack {
  const parts = dossier.operations
    .filter((op) => env.units.operations.has(op.id))
    .flatMap((op) => {
      const unit = env.unitOf.get(op.id);
      return unit === undefined ? [] : summariesOf(env, unit, 1, new Set()).filter((s) => s.id === op.id);
    });
  const nested = env.graph
    .childrenOf(dossier.id)
    .filter((child) => env.units.types.has(child))
    .flatMap((child) => {
      const unit = env.unitOf.get(child);
      return unit === undefined ? [] : summariesOf(env, unit, 1, new Set()).filter((s) => s.id === child);
    });
  return {
    id: dossier.id,
    level: "type",
    kind: dossier.kind,
    name: dossier.name ?? dossier.id,
    signature: undefined,
    containingType: undefined,
    containingModule: dossier.module === undefined ? undefined : displayName(env.graph, dossier.module),
    comments: commentsOf(env.graph, dossier.id),
    annotations: dossier.annotations.map(renderAnnotation),
    metrics: dossier.metrics,
    entryPoint: false,
    stereotype: dossier.stereotype,
    source: dossier.anchor === undefined ? undefined : env.reader.slice(dossier.anchor, env.maxLines),
    calls: [],
    accesses: [],
    throws: [],
    fields: dossier.fields.map((f) => ({
      name: f.name ?? f.id,
      type: f.declaredTypeName,
      typeKind: f.declaredTypeKind,
      external: f.declaredTypeExternal,
      value: f.value === undefined ? undefined : renderLiteral(f.value),
      annotations: f.annotations.map(renderAnnotation),
    })),
    supertypes: dossier.supertypes.map((s) => ({ name: s.name ?? s.to, relation: s.relation, external: s.external })),
    injectionPoints: dossier.injectionPoints.map((p) => ({
      name: displayName(env.graph, p.id),
      declaredType: p.declaredType === undefined ? undefined : displayName(env.graph, p.declaredType),
      candidates: p.candidates.map((c) => displayName(env.graph, c)),
    })),
    parts: [...parts, ...nested],
    imports: [],
  };
}

function modulePack(env: ContextEnv, module: ModuleFact): MemberPack {
  const parts = module.types
    .filter((t) => env.units.types.has(t))
    .flatMap((t) => {
      const unit = env.unitOf.get(t);
      return unit === undefined ? [] : summariesOf(env, unit, 1, new Set()).filter((s) => s.id === t);
    });
  return {
    id: module.id,
    level: "module",
    kind: env.graph.entity(module.id)?.kind ?? "module",
    name: module.name ?? module.id,
    signature: undefined,
    containingType: undefined,
    containingModule: undefined,
    comments: commentsOf(env.graph, module.id),
    annotations: [],
    metrics: undefined,
    entryPoint: false,
    stereotype: undefined,
    source: undefined,
    calls: [],
    accesses: [],
    throws: [],
    fields: [],
    supertypes: [],
    injectionPoints: [],
    parts,
    imports: module.imports.map((i) => ({ name: i.name ?? i.to, count: i.count, external: i.external })),
  };
}

function memberPack(env: ContextEnv, id: EntityId): MemberPack {
  const op = env.units.operations.get(id);
  if (op !== undefined) return operationPack(env, id, op.fact, env.units.types.get(op.typeId)!);
  const type = env.units.types.get(id);
  if (type !== undefined) return typePack(env, type);
  const module = env.units.modules.get(id);
  if (module !== undefined) return modulePack(env, module);
  throw new Error(`insights: ${id} is not a unit member`);
}

/** Facts only — no source, no comments, no explanations — for the fingerprint. */
function factsProjection(members: readonly MemberPack[]): unknown {
  return members.map((m) => ({
    id: m.id,
    kind: m.kind,
    annotations: m.annotations,
    metrics: m.metrics ?? null,
    entryPoint: m.entryPoint,
    stereotype: m.stereotype ?? null,
    calls: m.calls,
    accesses: m.accesses,
    throws: m.throws,
    fields: m.fields,
    supertypes: m.supertypes,
    injectionPoints: m.injectionPoints,
    imports: m.imports,
    partIds: m.parts.map((p) => p.id),
  }));
}

export function contextPackFor(unit: Unit, env: ContextEnv): ContextPack {
  const members = unit.members.map((id) => memberPack(env, id));
  const partIds = new Set(members.flatMap((m) => m.parts.map((p) => p.id)));
  const dependencies = unit.deps.flatMap((depId) => {
    const dep = env.unitOf.get(depId);
    if (dep === undefined) return [];
    // A part (a type's own operation, a module's own type) is listed under the
    // member; everything else is a dependency proper.
    if (dep.members.every((m) => partIds.has(m))) return [];
    return summariesOf(env, dep, env.depth, new Set([unit.id]));
  });
  return {
    unit,
    level: unit.level,
    members,
    dependencies,
    depth: env.depth,
    sources: members.map((m) => m.source?.text ?? ""),
    comments: members.flatMap((m) => m.comments),
    signatures: members.map((m) => m.signature ?? ""),
    factsDigest: digestOf(factsProjection(members)),
  };
}
