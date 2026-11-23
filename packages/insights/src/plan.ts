import { contextPackFor, type ContextEnv, type ContextPack } from "./context.js";
import { chainOf, fingerprintOf } from "./fingerprint.js";
import type { Unit, WalkPlan } from "./order.js";
import { estimateTokens, renderPrompts, type Prompt } from "./prompt.js";
import { sourceOf, type RecordSource } from "./records.js";
import { strictJsonSchema, type FailureRecord, type Level, type WalkRecord } from "./schema.js";
import { responseSchemaOf } from "./spec.js";
import type { TemplateKind, UnitSet } from "./units.js";

/**
 * THE RUN PLAN: what a run will do before it spends anything. Every unit in
 * walk order gets a status —
 *
 *   template     a trivial member, when the spec templates them; the block is computed, no model call
 *   reuse        every member already has a record with THIS fingerprint
 *                (or with the stamp from before the split, `stampedBeforeSplit`)
 *   skip-scope   outside the selection (`inScope`, selection.ts) and not
 *                reusable; dependents see it as NOT EXPLAINED
 *   skip-budget  `--max-calls` is spent; this and every later call is skipped,
 *                so what does run is always a dependency-consistent prefix
 *   llm          a model call (several, for a cycle larger than `--max-scc`)
 *
 * `existing` is a RecordSource (records.ts) — the store, on a real corpus — or
 * a plain map of records, which is copied into one.
 *
 * Fingerprints are exact here — they depend on inputs and on dependency
 * hashes, never on explanation text — so `reuse` is decided correctly
 * before any call. Token counts are ESTIMATES: prompts are rendered against
 * the records that exist now, and a dependency explained later in this run
 * will make the real prompt a little longer.
 */

export type StepStatus = "llm" | "template" | "reuse" | "skip-scope" | "skip-budget";

export interface PlanStep {
  readonly unit: Unit;
  readonly status: StepStatus;
  readonly model: string;
  readonly fingerprint: string;
  readonly template: TemplateKind | undefined;
  /** Model calls this step will make (0 unless `llm`). */
  readonly calls: number;
  /** Estimated prompt (input) tokens over those calls. */
  readonly promptTokens: number;
  /** Estimated completion (output) tokens over those calls — one block per member asked for. */
  readonly completionTokens: number;
}

export interface LevelEstimate {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  units: number;
}

export interface RunPlan {
  readonly steps: readonly PlanStep[];
  /** Per unit id, its plan-time hashes: what the run's records and dependents hash. */
  readonly hashes: ReadonlyMap<string, UnitHashes>;
  readonly estimates: {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly byLevel: Readonly<Record<Level, LevelEstimate>>;
    readonly byStatus: Readonly<Record<StepStatus, number>>;
  };
}

export interface PlanOptions {
  readonly models: { readonly leaf: string; readonly rollup: string };
  readonly depth: number;
  readonly maxLines: number;
  readonly maxScc: number;
  /** Re-explain everything, ignoring matching fingerprints. */
  readonly force: boolean;
  readonly maxCalls: number | undefined;
  /** Undefined = everything is in scope. */
  readonly inScope: ((unit: Unit) => boolean) | undefined;
  /** A module's glossary keeps its heaviest `terms` words (`--terms`). */
  readonly terms: number;
  /** What the transport adds to every prompt, for the estimate; the caller's to know (absent = nothing). */
  readonly promptOverhead?: PromptOverhead;
}

/**
 * Prompt tokens a call is billed beyond its system and user text: a fixed
 * count, plus the response schema when the transport puts it in the prompt.
 * A number, never a provider: the walk does not learn who it talks to.
 */
export interface PromptOverhead {
  readonly perCall: number;
  readonly schema: boolean;
}

export type PlanEnv = Omit<ContextEnv, "records" | "depth" | "maxLines" | "terms">;

export function modelFor(level: Level, models: PlanOptions["models"]): string {
  return level === "operation" ? models.leaf : models.rollup;
}

/** A planned unit's two hashes (fingerprint.ts): the one its records carry, and the one a word-blind dependent takes. */
export interface UnitHashes {
  readonly level: Level;
  readonly fingerprint: string;
  readonly chain: string;
}

/** A unit's dependencies as already hashed, in `unit.deps` order. */
export function dependenciesOf(unit: Unit, hashes: ReadonlyMap<string, UnitHashes>): readonly UnitHashes[] {
  return unit.deps.map((d) => hashes.get(d) ?? { level: unit.level, fingerprint: "", chain: "" });
}

/** Every input but the dependencies' hashes and the words; the spec's own (`walk`) only when it gives one. */
function inputsOf(pack: ContextPack, model: string, depth: number, missingDependencies: readonly string[]) {
  const walk = pack.spec.fingerprint?.(pack);
  return {
    level: pack.level,
    members: pack.unit.members,
    model,
    sources: pack.sources,
    comments: pack.comments,
    signatures: pack.signatures,
    factsDigest: pack.factsDigest,
    // A dependency unit that had no record when this unit was explained is
    // part of what it was explained WITHOUT; once it exists, redo the unit.
    // At plan time that is a skipped dependency; at run time (run.ts) it is
    // also a failed one — the record carries the run-time value.
    missingDependencies: [...missingDependencies].sort(),
    depth,
    ...(walk === undefined ? {} : { walk }),
  };
}

/**
 * A unit's hashes from its pack and its dependencies' hashes. It hashes a
 * dependency's whole fingerprint where its prompt shows that dependency's
 * words (the spec's `words.reads`), else the dependency's chain.
 */
export function unitHashes(
  pack: ContextPack,
  model: string,
  depth: number,
  dependencies: readonly UnitHashes[],
  missingDependencies: readonly string[],
): UnitHashes {
  const inputs = inputsOf(pack, model, depth, missingDependencies);
  const reads = (dependency: Level): boolean => pack.spec.words?.reads(pack.level, dependency) ?? false;
  return {
    level: pack.level,
    fingerprint: fingerprintOf({
      ...inputs,
      dependencyFingerprints: dependencies.map((d) => (reads(d.level) ? d.fingerprint : d.chain)).sort(),
      words: pack.words,
    }),
    chain: chainOf({ ...inputs, dependencyFingerprints: dependencies.map((d) => d.chain).sort() }),
  };
}

/**
 * The fingerprint as stamped before the split (2026-11): a unit hashed its
 * dependencies' whole fingerprints. Read for `reuse` only, never written: a
 * match means every transitive input is unchanged, words included, so the
 * split would reuse the record too. A leaf's is its fingerprint.
 */
export function stampedBeforeSplit(
  pack: ContextPack,
  model: string,
  depth: number,
  dependencyFingerprints: readonly string[],
  missingDependencies: readonly string[],
): string {
  return fingerprintOf({ ...inputsOf(pack, model, depth, missingDependencies), dependencyFingerprints: [...dependencyFingerprints].sort(), words: pack.words });
}

/**
 * The scope of a RETRY: the units a side-car recorded as failed, plus their
 * DIRECT dependents — explained without them, so stale the moment they exist.
 * Nothing further up moves: a unit hashes its dependencies' plan-time
 * hashes, which a failure never changed. Matching is by member, so a
 * failure still finds its unit after a re-extraction regrouped a cycle.
 */
export function retryScope(failures: readonly FailureRecord[], walk: WalkPlan): (unit: Unit) => boolean {
  const failed = new Set<string>();
  for (const failure of failures) {
    for (const member of failure.members) {
      const unit = walk.unitOf.get(member);
      if (unit !== undefined) failed.add(unit.id);
    }
  }
  return (unit) => failed.has(unit.id) || unit.deps.some((dep) => failed.has(dep));
}

/** A trivial member's unit (units.ts classifies): one operation, alone. A spec templates it (below) or a selection may skip it. */
export function trivialKindOf(unit: Unit, units: UnitSet): TemplateKind | undefined {
  if (unit.level !== "operation" || unit.members.length !== 1) return undefined;
  return units.operations.get(unit.members[0] ?? "")?.template;
}

/** A trivial member's template kind — only for a spec that templates them; any other asks it. */
function templateOf(env: PlanEnv, unit: Unit): TemplateKind | undefined {
  return env.spec.template === undefined ? undefined : trivialKindOf(unit, env.units);
}

export function planRun(
  walk: WalkPlan,
  existing: RecordSource | ReadonlyMap<string, WalkRecord>,
  env: PlanEnv,
  options: PlanOptions,
): RunPlan {
  const records = sourceOf(existing, env.spec);
  const contextEnv: ContextEnv = { ...env, records, depth: options.depth, maxLines: options.maxLines, terms: options.terms };
  const hashes = new Map<string, UnitHashes>();
  const before = new Map<string, string>();
  const steps: PlanStep[] = [];
  const byLevel: Record<Level, LevelEstimate> = {
    operation: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
    type: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
    module: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
  };
  const byStatus: Record<StepStatus, number> = { llm: 0, template: 0, reuse: 0, "skip-scope": 0, "skip-budget": 0 };
  const overhead = options.promptOverhead ?? { perCall: 0, schema: false };
  const schemaTokens = new Map<string, number>();
  const overheadOf = (level: Level, shape: Prompt["shape"]): number => {
    if (!overhead.schema) return overhead.perCall;
    const key = `${level}/${shape}`;
    let tokens = schemaTokens.get(key);
    if (tokens === undefined) schemaTokens.set(key, (tokens = estimateTokens(JSON.stringify(strictJsonSchema(responseSchemaOf(env.spec, level, shape))))));
    return overhead.perCall + tokens;
  };
  let budget = options.maxCalls ?? Number.POSITIVE_INFINITY;
  let exhausted = false;
  const statusOf = new Map<string, StepStatus>();

  for (const unit of walk.units) {
    const model = modelFor(unit.level, options.models);
    const pack = contextPackFor(unit, contextEnv);
    const missing = unit.deps.filter((d) => {
      const status = statusOf.get(d);
      return status === "skip-scope" || status === "skip-budget";
    });
    const own = unitHashes(pack, model, options.depth, dependenciesOf(unit, hashes), missing);
    const { fingerprint } = own;
    hashes.set(unit.id, own);
    const stamped =
      unit.deps.length === 0 ? fingerprint : stampedBeforeSplit(pack, model, options.depth, unit.deps.map((d) => before.get(d) ?? ""), missing);
    before.set(unit.id, stamped);
    byLevel[unit.level].units += 1;

    const template = templateOf(env, unit);
    const reusable =
      !options.force &&
      // Fingerprints alone: a plan that reuses everything reads no block (M16b).
      unit.members.every((id) => {
        const held = records.fingerprint(id);
        return held === fingerprint || held === stamped;
      });

    let status: StepStatus;
    let prompts: readonly Prompt[] = [];
    if (template !== undefined) status = "template";
    else if (reusable) status = "reuse";
    else if (options.inScope !== undefined && !options.inScope(unit)) status = "skip-scope";
    else {
      prompts = renderPrompts(pack, options.maxScc);
      if (exhausted || prompts.length > budget) {
        exhausted = true;
        status = "skip-budget";
        prompts = [];
      } else {
        status = "llm";
        budget -= prompts.length;
      }
    }
    const promptTokens = prompts.reduce((sum, p) => sum + estimateTokens(p.system) + estimateTokens(p.user) + overheadOf(unit.level, p.shape), 0);
    const completionTokens = prompts.reduce((sum, p) => sum + env.spec.completionTokens(unit.level, p.memberIds.length, p.asked), 0);
    statusOf.set(unit.id, status);
    byStatus[status] += 1;
    byLevel[unit.level].calls += prompts.length;
    byLevel[unit.level].promptTokens += promptTokens;
    byLevel[unit.level].completionTokens += completionTokens;
    steps.push({ unit, status, model, fingerprint, template, calls: prompts.length, promptTokens, completionTokens });
  }

  return {
    steps,
    hashes,
    estimates: {
      calls: steps.reduce((n, s) => n + s.calls, 0),
      promptTokens: steps.reduce((n, s) => n + s.promptTokens, 0),
      completionTokens: steps.reduce((n, s) => n + s.completionTokens, 0),
      byLevel,
      byStatus,
    },
  };
}
