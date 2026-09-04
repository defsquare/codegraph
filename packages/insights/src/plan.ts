import { contextPackFor, type ContextEnv, type ContextPack } from "./context.js";
import { fingerprintOf } from "./fingerprint.js";
import type { Unit, WalkPlan } from "./order.js";
import { estimateCompletionTokens, estimateTokens, renderPrompts, type Prompt } from "./prompt.js";
import type { InsightRecord, Level } from "./schema.js";
import type { TemplateKind } from "./units.js";

/**
 * THE RUN PLAN: what a run will do before it spends anything. Every unit in
 * walk order gets a status —
 *
 *   template     a trivial member; the block is computed, no model call
 *   reuse        every member already has a record with THIS fingerprint
 *   skip-scope   outside `--scope` and not reusable; dependents see it as
 *                NOT EXPLAINED
 *   skip-budget  `--max-calls` is spent; this and every later call is skipped,
 *                so what does run is always a dependency-consistent prefix
 *   llm          a model call (several, for a cycle larger than `--max-scc`)
 *
 * Fingerprints are exact here — they depend on inputs and on dependency
 * fingerprints, never on explanation text — so `reuse` is decided correctly
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
  readonly fingerprints: ReadonlyMap<string, string>;
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
}

export type PlanEnv = Omit<ContextEnv, "records" | "depth" | "maxLines">;

export function modelFor(level: Level, models: PlanOptions["models"]): string {
  return level === "operation" ? models.leaf : models.rollup;
}

/** The fingerprint of a unit from its pack and its dependencies' fingerprints. */
export function unitFingerprint(
  pack: ContextPack,
  model: string,
  depth: number,
  dependencyFingerprints: readonly string[],
  missingDependencies: readonly string[],
): string {
  return fingerprintOf({
    level: pack.level,
    members: pack.unit.members,
    model,
    sources: pack.sources,
    comments: pack.comments,
    signatures: pack.signatures,
    factsDigest: pack.factsDigest,
    dependencyFingerprints: [...dependencyFingerprints].sort(),
    // A dependency unit that had no record when this unit was explained is
    // part of what it was explained WITHOUT; once it exists, redo the unit.
    // At plan time that is a skipped dependency; at run time (run.ts) it is
    // also a failed one — the record carries the run-time value.
    missingDependencies: [...missingDependencies].sort(),
    depth,
  });
}

function templateOf(env: PlanEnv, unit: Unit): TemplateKind | undefined {
  if (unit.level !== "operation" || unit.members.length !== 1) return undefined;
  return env.units.operations.get(unit.members[0] ?? "")?.template;
}

export function planRun(
  walk: WalkPlan,
  existing: ReadonlyMap<string, InsightRecord>,
  env: PlanEnv,
  options: PlanOptions,
): RunPlan {
  const contextEnv: ContextEnv = { ...env, records: existing, depth: options.depth, maxLines: options.maxLines };
  const fingerprints = new Map<string, string>();
  const steps: PlanStep[] = [];
  const byLevel: Record<Level, LevelEstimate> = {
    operation: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
    type: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
    module: { calls: 0, promptTokens: 0, completionTokens: 0, units: 0 },
  };
  const byStatus: Record<StepStatus, number> = { llm: 0, template: 0, reuse: 0, "skip-scope": 0, "skip-budget": 0 };
  let budget = options.maxCalls ?? Number.POSITIVE_INFINITY;
  let exhausted = false;
  const statusOf = new Map<string, StepStatus>();

  for (const unit of walk.units) {
    const model = modelFor(unit.level, options.models);
    const pack = contextPackFor(unit, contextEnv);
    const depFingerprints = unit.deps.map((d) => fingerprints.get(d) ?? "");
    const missing = unit.deps.filter((d) => {
      const status = statusOf.get(d);
      return status === "skip-scope" || status === "skip-budget";
    });
    const fingerprint = unitFingerprint(pack, model, options.depth, depFingerprints, missing);
    fingerprints.set(unit.id, fingerprint);
    byLevel[unit.level].units += 1;

    const template = templateOf(env, unit);
    const reusable =
      !options.force &&
      unit.members.every((id) => existing.get(id)?.fingerprint === fingerprint);

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
    const promptTokens = prompts.reduce((sum, p) => sum + estimateTokens(p.system) + estimateTokens(p.user), 0);
    const completionTokens = prompts.reduce((sum, p) => sum + estimateCompletionTokens(unit.level, p.memberIds.length), 0);
    statusOf.set(unit.id, status);
    byStatus[status] += 1;
    byLevel[unit.level].calls += prompts.length;
    byLevel[unit.level].promptTokens += promptTokens;
    byLevel[unit.level].completionTokens += completionTokens;
    steps.push({ unit, status, model, fingerprint, template, calls: prompts.length, promptTokens, completionTokens });
  }

  return {
    steps,
    fingerprints,
    estimates: {
      calls: steps.reduce((n, s) => n + s.calls, 0),
      promptTokens: steps.reduce((n, s) => n + s.promptTokens, 0),
      completionTokens: steps.reduce((n, s) => n + s.completionTokens, 0),
      byLevel,
      byStatus,
    },
  };
}
