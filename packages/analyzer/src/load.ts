import {
  getProfile,
  parseModel,
  selfReferences,
  unknownReferences,
  validateModel,
  type Edge,
  type Entity,
  type EntityId,
  type Model,
} from "@codegraph/core";
import { compareIds } from "./order.js";

/**
 * Stage 1 of the pipeline (PLAN.md §6.1): load one or more model.json payloads
 * into one validated union.
 *
 * Two failure classes, treated differently on purpose:
 *  - SCHEMA errors are fatal — a payload that is not a Model cannot be
 *    analyzed at all, so `parseModel` throws (wrapped with its source label).
 *  - PROFILE violations are COLLECTED — a model that breaks its profile is
 *    still a graph, and refusing to look at it helps nobody.
 *
 * Nothing here mutates an input: the union holds the parsed models as they are.
 */

/** Where one model in the union came from, for diagnostics that name their source. */
export interface ModelSource {
  readonly index: number;
  /** Caller-supplied label (a file path, typically) or `model[i]`. */
  readonly label: string;
  readonly lang: string;
}

/**
 * The union of every loaded model. Multi-language is in scope: ids are globally
 * unique thanks to the lang prefix, so entities and edges concatenate without
 * renaming. `entities`/`edges` are flat views over `models`, in input order.
 */
export interface ModelUnion {
  readonly models: readonly Model[];
  readonly sources: readonly ModelSource[];
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
  /** Distinct `lang` values present, sorted. */
  readonly langs: readonly string[];
}

export interface SchemaError {
  readonly modelIndex: number;
  readonly label: string;
  readonly message: string;
}

/** One `validateModel` issue, tagged with the model it came from. */
export interface ProfileIssue {
  readonly modelIndex: number;
  readonly label: string;
  readonly lang: string;
  /** A `VALIDATION_CODES` member; matched on, never the message. */
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** A reference that resolves to no declared entity anywhere in the union. */
export interface DanglingReference {
  readonly modelIndex: number;
  readonly label: string;
  /** Path inside the owning model, e.g. `edges[12].to` or `entities[3].parent`. */
  readonly path: string;
  readonly id: EntityId;
}

/** An edge with `from === to` — forbidden by METAMODEL.md §4. */
export interface SelfEdge {
  readonly modelIndex: number;
  readonly label: string;
  readonly path: string;
  readonly edge: Edge;
}

/**
 * An id declared more than once. Benign when every declaration agrees on kind
 * and trait set (TS declaration merging, C# partial classes — METAMODEL.md
 * §1.1); a real conflict otherwise, and then `conflicting` is true.
 */
export interface DuplicateId {
  readonly id: EntityId;
  readonly occurrences: number;
  readonly modelIndexes: readonly number[];
  readonly conflicting: boolean;
}

export interface LoadDiagnostics {
  /** Non-empty only under `onSchemaError: "collect"`; the default throws. */
  readonly schemaErrors: readonly SchemaError[];
  readonly profileIssues: readonly ProfileIssue[];
  /** Profile issues bucketed by `code`, so a caller can gate on a code count. */
  readonly profileIssueCounts: Readonly<Record<string, number>>;
  /** Langs with no profile in core's registry: not validated, still analyzed. */
  readonly unknownProfiles: readonly string[];
  readonly danglingReferences: readonly DanglingReference[];
  readonly selfEdges: readonly SelfEdge[];
  readonly duplicateIds: readonly DuplicateId[];
}

export interface LoadResult {
  readonly union: ModelUnion;
  readonly diagnostics: LoadDiagnostics;
}

export interface LoadOptions {
  /** Labels by input index (file paths); defaults to `model[i]`. */
  readonly sources?: readonly string[];
  /**
   * `throw` (default) hard-fails on a payload that is not a valid Model.
   * `collect` skips it and records a `SchemaError` — for a batch run that must
   * report on every file rather than die on the first bad one.
   */
  readonly onSchemaError?: "throw" | "collect";
}

/** Thrown on a schema error, naming which input failed. `cause` is core's error. */
export class ModelLoadError extends Error {
  readonly modelIndex: number;
  readonly label: string;

  constructor(modelIndex: number, label: string, cause: unknown) {
    super(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ModelLoadError";
    this.modelIndex = modelIndex;
    this.label = label;
  }
}

/**
 * Same rule as core's private `sameDeclaration`: one id may be declared several
 * times, and only a disagreement on kind or trait set is a conflict. Core
 * applies it within one model; the union needs it across models too.
 */
function sameDeclaration(a: Entity, b: Entity): boolean {
  if (a.kind !== b.kind) return false;
  const left = [...new Set<string>(a.traits)].sort(compareIds);
  const right = [...new Set<string>(b.traits)].sort(compareIds);
  return left.length === right.length && left.every((trait, i) => trait === right[i]);
}

function toArray(inputs: unknown): unknown[] {
  return Array.isArray(inputs) ? [...(inputs as unknown[])] : [inputs];
}

/**
 * Load, validate and unify. `inputs` is one model (parsed `Model` or raw parsed
 * JSON) or an array of them — `parseModel` accepts both, since a `Model` parses
 * to an equal `Model`.
 *
 * This is the entry point for a payload NOBODY has validated: raw parsed JSON,
 * a model a test built by hand, a future extractor's in-memory output. It is
 * `parseModel` followed by {@link loadDecodedModels}, and nothing else.
 */
export function loadModels(inputs: unknown, options: LoadOptions = {}): LoadResult {
  const raw = toArray(inputs);
  const labels = options.sources ?? [];
  const onSchemaError = options.onSchemaError ?? "throw";

  const kept: Loaded[] = [];
  const schemaErrors: SchemaError[] = [];

  raw.forEach((payload, index) => {
    const label = labels[index] ?? `model[${index}]`;
    let model: Model;
    try {
      model = parseModel(payload);
    } catch (error) {
      if (onSchemaError === "throw") throw new ModelLoadError(index, label, error);
      schemaErrors.push({
        modelIndex: index,
        label,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    kept.push({ model, label, index });
  });

  return unify(kept, schemaErrors);
}

/**
 * Unify and diagnose models that are ALREADY validated — skipping the schema
 * pass, and only that.
 *
 * Who may call this: a caller that got its models from something which already
 * enforced core's schemas record by record. `readModelFileSync` is exactly
 * that: every line is parsed against its record schema, trait keys are checked
 * against `WIRE_TRAITS`, and the container rules (section order, dense
 * surrogates, closure, eof counts) are enforced as it reads. Re-running
 * `parseModel` over the result is a second full Zod pass that can only agree —
 * measured on apache/fineract: 2.6 s of the 11.7 s a command takes.
 *
 * What is NOT skipped, because none of it is redundant: profile validation,
 * closure OVER THE UNION (one model may reference another's ids), self-edges
 * and cross-model redeclaration. `loadModels` and this function agree on every
 * one of those, which `load-equivalence.test.ts` pins over every fixture and
 * every deliberately-broken model.
 */
export function loadDecodedModels(
  models: readonly Model[],
  options: Omit<LoadOptions, "onSchemaError"> = {},
): LoadResult {
  const labels = options.sources ?? [];
  return unify(
    models.map((model, index) => ({ model, label: labels[index] ?? `model[${index}]`, index })),
    [],
  );
}

/** One validated model, with the ARGUMENT position every diagnostic reports. */
interface Loaded {
  readonly model: Model;
  readonly label: string;
  readonly index: number;
}

/** The half both entry points share: concatenate, then diagnose. */
function unify(loaded: readonly Loaded[], schemaErrors: readonly SchemaError[]): LoadResult {
  const models = loaded.map((one) => one.model);
  // The argument position is carried, never recomputed: two inputs may share a
  // label (the same path passed twice is a legal union) and a skipped payload
  // shifts every position after it.
  const sources: ModelSource[] = loaded.map((one) => ({
    index: one.index,
    label: one.label,
    lang: one.model.lang,
  }));

  // Element by element, NEVER `push(...model.entities)`: a spread passes one
  // ARGUMENT per element, and a real corpus overflows the call stack long
  // before it exhausts memory — apache/fineract (240 929 entities) failed here
  // with `Maximum call stack size exceeded`, reported as an internal error
  // because that is exactly what it was.
  const entities: Entity[] = [];
  const edges: Edge[] = [];
  for (const model of models) {
    for (const entity of model.entities) entities.push(entity);
    for (const edge of model.edges) edges.push(edge);
  }

  const union: ModelUnion = {
    models,
    sources,
    entities,
    edges,
    langs: [...new Set(models.map((m) => m.lang))].sort(compareIds),
  };

  return { union, diagnostics: diagnose(union, schemaErrors) };
}

/** Profile validation, closure, self-edges and duplicate ids over the union. */
function diagnose(union: ModelUnion, schemaErrors: readonly SchemaError[]): LoadDiagnostics {
  const profileIssues: ProfileIssue[] = [];
  const profileIssueCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const unknownProfiles = new Set<string>();

  union.models.forEach((model, i) => {
    const source = union.sources[i];
    const label = source?.label ?? `model[${i}]`;
    const profile = getProfile(model.lang);
    if (profile === undefined) {
      unknownProfiles.add(model.lang);
      return;
    }
    for (const issue of validateModel(model, profile)) {
      profileIssues.push({
        modelIndex: source?.index ?? i,
        label,
        lang: model.lang,
        code: issue.code,
        path: issue.path,
        message: issue.message,
      });
      profileIssueCounts[issue.code] = (profileIssueCounts[issue.code] ?? 0) + 1;
    }
  });

  // Closure (CLAUDE.md invariant 10) holds over the CORPUS, not over one file:
  // a model may legitimately reference an id another model declares, so the
  // known set is the union's ids — stubs included, they ARE declared entities.
  const known = new Set<EntityId>(union.entities.map((entity) => entity.id));
  const danglingReferences: DanglingReference[] = [];
  const selfEdges: SelfEdge[] = [];

  union.models.forEach((model, i) => {
    const source = union.sources[i];
    const modelIndex = source?.index ?? i;
    const label = source?.label ?? `model[${i}]`;
    for (const ref of unknownReferences(model, known)) {
      danglingReferences.push({ modelIndex, label, path: ref.path, id: ref.id });
    }
    for (const self of selfReferences(model)) {
      selfEdges.push({ modelIndex, label, path: self.path, edge: self.edge });
    }
  });

  return {
    schemaErrors,
    profileIssues,
    profileIssueCounts: Object.freeze(profileIssueCounts),
    unknownProfiles: [...unknownProfiles].sort(compareIds),
    danglingReferences,
    selfEdges,
    duplicateIds: duplicateIds(union),
  };
}

function duplicateIds(union: ModelUnion): DuplicateId[] {
  const seen = new Map<EntityId, { first: Entity; occurrences: number; models: number[]; conflicting: boolean }>();

  union.models.forEach((model, i) => {
    const modelIndex = union.sources[i]?.index ?? i;
    for (const entity of model.entities) {
      const previous = seen.get(entity.id);
      if (previous === undefined) {
        seen.set(entity.id, {
          first: entity,
          occurrences: 1,
          models: [modelIndex],
          conflicting: false,
        });
        continue;
      }
      previous.occurrences += 1;
      if (!previous.models.includes(modelIndex)) previous.models.push(modelIndex);
      if (!sameDeclaration(previous.first, entity)) previous.conflicting = true;
    }
  });

  const out: DuplicateId[] = [];
  for (const [id, record] of seen) {
    if (record.occurrences < 2) continue;
    out.push({
      id,
      occurrences: record.occurrences,
      modelIndexes: [...record.models].sort((a, b) => a - b),
      conflicting: record.conflicting,
    });
  }
  return out.sort((a, b) => compareIds(a.id, b.id));
}

/** True when nothing in the diagnostics blocks a trustworthy analysis. */
export function isClean(diagnostics: LoadDiagnostics): boolean {
  return (
    diagnostics.schemaErrors.length === 0 &&
    diagnostics.profileIssues.length === 0 &&
    diagnostics.danglingReferences.length === 0 &&
    diagnostics.selfEdges.length === 0 &&
    diagnostics.duplicateIds.every((duplicate) => !duplicate.conflicting)
  );
}
