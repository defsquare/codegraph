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
import type { RecordSource, RecordSummary } from "./records.js";
import type { Level, WordEntry } from "./schema.js";
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
 *
 * A SUMMARY IS READ WHEN A PROMPT READS IT (M16b). A pack is built for every
 * unit of every plan — its fingerprint needs the facts — but only a unit that
 * is about to be sent has its prompt rendered. So `summary` and `concept` are
 * memoized getters over the record source: building a pack reads no block,
 * and a re-run that reuses everything never touches one. The fingerprint
 * reads neither (it hashes part IDS), which is what makes that sound.
 *
 * WORDS (PLAN.md §20.3). A member asks the model to define the words of its
 * names: its own, an operation's parameters', a type's fields'. They are
 * GIVEN, split by the injected `Speller` (the CLI hands `@codegraph/vocabulary`'s
 * in), so this package runs no splitter. A module is also shown what its types
 * said of the words they spell, heaviest first, cut at `terms`: read like a
 * summary, when the prompt renders, and never hashed.
 */

/** What a unit's names spell, injected: `@codegraph/vocabulary` through the CLI, a toy in tests. */
export interface Speller {
  /** The words of an entity's own name a definition is asked for, each once, in name order; none for an unnamed name. */
  words(id: EntityId): readonly string[];
  /** A module's askable words, heaviest first: the order its glossary is cut in. */
  ranked(moduleId: EntityId): readonly string[];
}

/** One identifier of a member and the words of it the model defines. */
export interface NameWords {
  /** As the code writes it. */
  readonly identifier: string;
  readonly words: readonly string[];
}

/** A word a module's types spell, with what each of them said of it. */
export interface GlossaryWord {
  readonly word: string;
  /** Read from the record source on first use: a type's `words` entry for this word, by type name. */
  readonly entries: readonly { readonly type: string; readonly entry: WordEntry }[];
}

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
  /** The identifiers whose words this member's block defines: its own name first. Only those with a word. */
  readonly names: readonly NameWords[];
  /** A module's: the words its types spell, heaviest first, cut at `terms`. Empty below a module. */
  readonly glossary: readonly GlossaryWord[];
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
  /** Per member: the words asked and a module's glossary words — never what was said of them. */
  readonly words: readonly { readonly names: readonly NameWords[]; readonly glossary: readonly string[] }[];
}

export interface ContextEnv {
  readonly graph: CodeGraph;
  readonly facts: DomainFacts;
  readonly units: UnitSet;
  readonly reader: SourceReader;
  readonly records: RecordSource;
  readonly unitOf: ReadonlyMap<EntityId, Unit>;
  readonly depth: number;
  readonly maxLines: number;
  readonly speller: Speller;
  /** A module's glossary keeps its heaviest `terms` words. */
  readonly terms: number;
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
  return unit.members.map((id) => lazySummary(env, id, unit.level, children));
}

/** `missing` costs a fingerprint lookup; `summary`/`concept` ask the source once, on first use. */
function lazySummary(env: ContextEnv, id: EntityId, level: Level, children: readonly DependencySummary[]): DependencySummary {
  let read = false;
  let quoted: RecordSummary | undefined;
  const quote = (): RecordSummary | undefined => {
    if (!read) {
      quoted = env.records.summary(id);
      read = true;
    }
    return quoted;
  };
  return {
    id,
    level,
    name: displayName(env.graph, id),
    get summary() {
      return quote()?.description ?? "";
    },
    get concept() {
      return quote()?.concept;
    },
    get missing() {
      return env.records.fingerprint(id) === undefined;
    },
    children,
  };
}

function commentsOf(graph: CodeGraph, id: EntityId): readonly string[] {
  const entity = graph.entity(id);
  if (entity === undefined || !hasTrait(entity, "TComment")) return [];
  const value = (entity as Record<string, unknown>)["comments"];
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
}

/** The identifiers among `ids` that spell a word to define, in order, each identifier once. */
function namesOf(env: ContextEnv, ids: readonly EntityId[]): NameWords[] {
  const names: NameWords[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const entity = env.graph.entity(id);
    const identifier = entity === undefined ? undefined : entityName(entity);
    if (identifier === undefined || seen.has(identifier)) continue;
    const words = env.speller.words(id);
    if (words.length === 0) continue;
    seen.add(identifier);
    names.push({ identifier, words });
  }
  return names;
}

function parametersOf(env: ContextEnv, id: EntityId): EntityId[] {
  const value = (env.graph.entity(id) as Record<string, unknown> | undefined)?.["parameters"];
  return Array.isArray(value) ? value.filter((p): p is EntityId => typeof p === "string") : [];
}

function typeNames(env: ContextEnv, dossier: TypeDossier): NameWords[] {
  return namesOf(env, [dossier.id, ...dossier.fields.map((f) => f.id)]);
}

/**
 * The words a module's types spell, heaviest first by the speller's ranking
 * (an unranked word after, by text), cut at `terms`. What the types said of
 * them is read once, when a prompt first asks.
 */
function glossaryOf(env: ContextEnv, types: readonly TypeDossier[], moduleId: EntityId): GlossaryWord[] {
  const spelled = new Set(types.flatMap((t) => typeNames(env, t).flatMap((n) => n.words)));
  const rank = new Map(env.speller.ranked(moduleId).map((word, i) => [word, i]));
  const ordered = [...spelled].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  let said: Map<string, { type: string; entry: WordEntry }[]> | undefined;
  const read = (): Map<string, { type: string; entry: WordEntry }[]> => {
    if (said === undefined) {
      said = new Map();
      for (const t of types) {
        for (const entry of env.records.words(t.id) ?? []) {
          const list = said.get(entry.word) ?? [];
          list.push({ type: t.name ?? t.id, entry });
          said.set(entry.word, list);
        }
      }
    }
    return said;
  };
  return ordered.slice(0, Math.max(0, env.terms)).map((word) => ({
    word,
    get entries() {
      return read().get(word) ?? [];
    },
  }));
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
    names: namesOf(env, [id, ...parametersOf(env, id)]),
    glossary: [],
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
    names: typeNames(env, dossier),
    glossary: [],
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
    names: namesOf(env, [module.id]),
    glossary: glossaryOf(
      env,
      module.types.flatMap((t) => {
        const dossier = env.units.types.get(t);
        return dossier === undefined ? [] : [dossier];
      }),
      module.id,
    ),
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
    words: members.map((m) => ({ names: m.names, glossary: m.glossary.map((g) => g.word) })),
  };
}
