import type { z } from "zod";
import { contextPackFor, type ContextEnv } from "./context.js";
import type { Unit } from "./order.js";
import { unitFingerprint, type PlanEnv, type PlanStep, type RunPlan } from "./plan.js";
import { renderPrompts, type Prompt } from "./prompt.js";
import { bookOf, type RecordBook } from "./records.js";
import {
  BLOCKS,
  clampConfidence,
  responseJsonSchema,
  sccResponseSchema,
  type Block,
  type FailureReason,
  type FailureRecord,
  type InsightRecord,
  type JsonSchema,
  type Level,
  type RecordKey,
  type RecordUsage,
} from "./schema.js";
import { sortFailures } from "./sidecar.js";
import { templateBlock } from "./template.js";

/**
 * EXECUTING A PLAN. Layer by layer — every unit in a layer has all its
 * dependencies in earlier layers — with up to `concurrency` model calls in
 * flight inside a layer. Prompts are rendered HERE, against the records
 * produced so far, so a dependency explained a moment ago is already in its
 * dependent's prompt.
 *
 * IT HOLDS NO RECORD (M16b). What is explained lives in a `RecordBook`
 * (records.ts): a finished unit is `put` there, and a later unit's prompt reads
 * its dependencies back from there — the store, on a real corpus, so a run's
 * memory is its graph and the layer in flight, not everything ever explained.
 *
 * No I/O of its own: the model call is an injected `Completer` (the CLI wraps
 * an `LlmClient`; tests pass a function), and every finished record is handed
 * to `onRecord`, every finished unit to `onUnit` and every failure to
 * `onFailure` — the CLI's progressive writes to the insights store.
 *
 * A malformed answer gets ONE repair re-ask with the validation errors quoted.
 * A unit that still fails is left without a record and gets a FAILURE record
 * instead — the unit, its entities, the reason — which the side-car keeps
 * until a later run explains it (`retryScope` in plan.ts). Its
 * dependents run anyway and see it as NOT EXPLAINED — and because a missing
 * dependency is part of their fingerprint, a later run that explains it will
 * redo them. The result set is the same whatever the concurrency: only the
 * order of calls differs.
 *
 * ONE FAILURE IS NOT ABOUT ITS UNIT: a 401, 402 or 403 is about the account,
 * and every later call would get the same answer. The run ABORTS — no further
 * call starts; templates and reuse still happen — and the units it never
 * reached are reported as not attempted, never as failed: a failure record
 * says a unit was asked for.
 */

/** Statuses that condemn every later call too: bad key, no credits, no permission. */
export const FATAL_STATUSES: readonly number[] = [401, 402, 403];

export interface RunAbort {
  /** The unit whose call got the fatal answer. */
  readonly unit: string;
  readonly reason: FailureReason;
  /** Planned model-call units that were never started. */
  readonly notAttempted: number;
}


export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly jsonSchema: JsonSchema;
}

export interface Completion {
  readonly json: unknown;
  readonly model: string;
  readonly usage?: RecordUsage;
}

/**
 * May reject. An error carrying a numeric `status` and/or a boolean `retryable`
 * (the shape of `@codegraph/llm`'s `LlmError`, read structurally — this package
 * imports no client) is recorded as a `provider` failure with both; a status
 * in `FATAL_STATUSES` also aborts the run.
 */
export type Completer = (request: CompletionRequest) => Promise<Completion>;

export interface StepEvent {
  readonly step: PlanStep;
  readonly outcome: "done" | "failed" | "skipped";
  readonly calls: number;
  readonly usage: RunUsage;
  readonly error?: string;
  /** Skipped because the run had aborted, not by plan. */
  readonly aborted?: true;
}

export interface RunHooks {
  readonly concurrency: number;
  readonly onRecord?: (record: InsightRecord, step: PlanStep) => void | Promise<void>;
  /** Every record of a finished unit at once — a cycle's members together: what a store commits as ONE transaction. */
  readonly onUnit?: (records: readonly InsightRecord[], step: PlanStep) => void | Promise<void>;
  /** A unit asked for and left without a record, the moment it fails — not at the layer boundary. */
  readonly onFailure?: (failure: FailureRecord, step: PlanStep) => void | Promise<void>;
  readonly onStep?: (event: StepEvent) => void;
  /** After every layer has settled, with what is still owed. Not the records: handing them over would hold them all. */
  readonly onLayer?: (layer: number, failures: readonly FailureRecord[]) => void | Promise<void>;
}

export interface RunOptions {
  readonly maxScc: number;
  readonly depth: number;
  readonly maxLines: number;
  /** The natural key per entity id, when the caller has it. */
  readonly keyOf?: (id: string) => RecordKey | undefined;
  /** The side-car's failures from earlier runs: attempts are counted on, unattempted ones carried over. */
  readonly previousFailures?: readonly FailureRecord[];
}

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number | undefined;
}

export interface RunResult {
  /**
   * Existing records carried over plus everything produced, sorted — read from
   * the book ON ACCESS, materializing every record. A test's convenience; a
   * run over a store never touches it (`counts.records` is the book's size).
   */
  readonly records: readonly InsightRecord[];
  readonly counts: {
    readonly records: number;
    readonly llm: number;
    readonly template: number;
    readonly reused: number;
    readonly failed: number;
    readonly skipped: number;
    readonly calls: number;
  };
  readonly usage: RunUsage;
  /** Every unit still owed an explanation after this run: failed now, or failed before and not attempted. Sorted. */
  readonly failures: readonly FailureRecord[];
  /** Set when a fatal provider answer stopped the run early. */
  readonly aborted: RunAbort | undefined;
}

export class RunAborted extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunAborted";
  }
}

function addUsage(total: RunUsage, usage: RecordUsage | undefined): void {
  if (usage === undefined) return;
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost;
}

/** Share one call's usage across the members it explained. */
function splitUsage(usage: RecordUsage | undefined, parts: number): RecordUsage | undefined {
  if (usage === undefined || parts <= 1) return usage;
  return {
    promptTokens: Math.round(usage.promptTokens / parts),
    completionTokens: Math.round(usage.completionTokens / parts),
    ...(usage.cost === undefined ? {} : { cost: usage.cost / parts }),
  };
}

function reasonOf(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RunAborted) return { kind: "invalid-answer", message };
  const { status, retryable } = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; retryable?: unknown };
  const hasStatus = typeof status === "number" && Number.isInteger(status);
  if (!hasStatus && typeof retryable !== "boolean") return { kind: "error", message };
  return { kind: "provider", message, ...(hasStatus ? { status } : {}), ...(typeof retryable === "boolean" ? { retryable } : {}) };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Validate one answer; returns the blocks by member id or the validation message. */
function parseAnswer(level: Level, prompt: Prompt, json: unknown): { blocks: Map<string, Block> } | { error: string } {
  if (prompt.shape === "block") {
    const parsed = BLOCKS[level].safeParse(json);
    if (!parsed.success) return { error: issuesOf(parsed.error) };
    return { blocks: new Map([[prompt.memberIds[0] ?? "", clampConfidence(parsed.data as Block)]]) };
  }
  const parsed = sccResponseSchema(level).safeParse(json);
  if (!parsed.success) return { error: issuesOf(parsed.error) };
  const blocks = new Map<string, Block>();
  for (const member of parsed.data.members) blocks.set(member.id, clampConfidence(member.block as Block));
  const missing = prompt.memberIds.filter((id) => !blocks.has(id));
  if (missing.length > 0) return { error: `no entry for member id(s): ${missing.join(", ")}` };
  return { blocks };
}

export async function executeRun(
  plan: RunPlan,
  env: PlanEnv,
  existing: RecordBook | ReadonlyMap<string, InsightRecord>,
  complete: Completer,
  options: RunOptions,
  hooks: RunHooks,
): Promise<RunResult> {
  // A map is copied into a book of its own; a book (the store) is written to.
  const book = bookOf(existing);
  const explained = (id: string): boolean => book.fingerprint(id) !== undefined;
  const usage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: undefined };
  const failures = new Map<string, FailureRecord>();
  const previous = new Map((options.previousFailures ?? []).map((failure) => [failure.id, failure]));
  // Still owed: what failed in this run, plus what failed before and has no record yet.
  const owed = (): FailureRecord[] =>
    sortFailures([...failures.values(), ...[...previous.values()].filter((f) => !failures.has(f.id) && carried.has(f.id))]);
  const carried = new Set<string>();
  let abort: { unit: string; reason: FailureReason } | undefined;
  let notAttempted = 0;
  // Not attempted: an earlier failure of this unit stands until its members have records.
  const carry = (unit: Unit): void => {
    if (previous.has(unit.id) && unit.members.some((member) => !explained(member))) carried.add(unit.id);
  };
  const counts = { llm: 0, template: 0, reused: 0, failed: 0, skipped: 0, calls: 0 };
  const contextEnv: ContextEnv = { ...env, records: book, depth: options.depth, maxLines: options.maxLines };

  const describe = (id: string): { kind: string; name: string | undefined; file: string | undefined } => {
    const op = env.units.operations.get(id);
    if (op !== undefined) return { kind: op.fact.kind, name: op.fact.name, file: op.fact.anchor?.file };
    const type = env.units.types.get(id);
    if (type !== undefined) return { kind: type.kind, name: type.name, file: type.anchor?.file };
    const module = env.units.modules.get(id);
    return { kind: env.graph.entity(id)?.kind ?? "module", name: module?.name, file: undefined };
  };

  const record = (unit: Unit, id: string, block: Block, fingerprint: string, origin: "llm" | "template", model: string | undefined, callUsage: RecordUsage | undefined): InsightRecord => {
    const meta = describe(id);
    const key = options.keyOf?.(id);
    return {
      t: "i",
      id,
      ...(key === undefined ? {} : { key }),
      level: unit.level,
      kind: meta.kind,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.file === undefined ? {} : { file: meta.file }),
      ...(unit.members.length > 1 ? { scc: unit.members } : {}),
      origin,
      block,
      fingerprint,
      ...(model === undefined ? {} : { model }),
      ...(callUsage === undefined ? {} : { usage: callUsage }),
    } as InsightRecord;
  };

  const emit = async (unit: readonly InsightRecord[], step: PlanStep): Promise<void> => {
    // Put first: once it returns, every later prompt can quote this unit.
    await book.put(step.unit.id, unit);
    for (const rec of unit) await hooks.onRecord?.(rec, step);
    await hooks.onUnit?.(unit, step);
  };

  const runStep = async (step: PlanStep): Promise<void> => {
    const { unit } = step;
    const stepUsage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: undefined };
    switch (step.status) {
      case "template": {
        const id = unit.members[0] ?? "";
        const op = env.units.operations.get(id)!;
        const block = templateBlock(op, step.template!, env.units.types.get(op.typeId)!);
        await emit([record(unit, id, block, step.fingerprint, "template", undefined, undefined)], step);
        counts.template += 1;
        hooks.onStep?.({ step, outcome: "done", calls: 0, usage: stepUsage });
        return;
      }
      case "reuse":
        counts.reused += unit.members.length;
        hooks.onStep?.({ step, outcome: "done", calls: 0, usage: stepUsage });
        return;
      case "skip-scope":
      case "skip-budget":
        carry(unit);
        counts.skipped += 1;
        hooks.onStep?.({ step, outcome: "skipped", calls: 0, usage: stepUsage });
        return;
      case "llm":
        break;
    }
    if (abort !== undefined) {
      carry(unit);
      counts.skipped += 1;
      notAttempted += 1;
      hooks.onStep?.({ step, outcome: "skipped", calls: 0, usage: stepUsage, aborted: true });
      return;
    }

    const pack = contextPackFor(unit, contextEnv);
    const prompts = renderPrompts(pack, options.maxScc);
    // The run-time fingerprint: a dependency that failed is missing too.
    const missing = unit.deps.filter((d) => {
      const dep = env.unitOf.get(d);
      return dep === undefined || dep.members.some((member) => !explained(member));
    });
    const fingerprint = unitFingerprint(pack, step.model, options.depth, unit.deps.map((d) => plan.fingerprints.get(d) ?? ""), missing);
    const produced: InsightRecord[] = [];
    let calls = 0;
    try {
      for (const prompt of prompts) {
        const jsonSchema = responseJsonSchema(unit.level, prompt.shape);
        const request: CompletionRequest = { model: step.model, system: prompt.system, user: prompt.user, schemaName: prompt.schemaName, jsonSchema };
        let completion = await complete(request);
        calls += 1;
        addUsage(stepUsage, completion.usage);
        let answer = parseAnswer(unit.level, prompt, completion.json);
        if ("error" in answer) {
          // One repair re-ask: the same prompt plus what was wrong with the answer.
          completion = await complete({
            ...request,
            user: `${prompt.user}\n## Your previous answer was not valid\n${answer.error}\nReturn only the corrected JSON document.\n`,
          });
          calls += 1;
          addUsage(stepUsage, completion.usage);
          answer = parseAnswer(unit.level, prompt, completion.json);
          if ("error" in answer) throw new RunAborted(`invalid answer after repair: ${answer.error}`);
        }
        const share = splitUsage(completion.usage, answer.blocks.size);
        for (const [id, block] of answer.blocks) produced.push(record(unit, id, block, fingerprint, "llm", completion.model, share));
      }
    } catch (error) {
      counts.calls += calls;
      addUsage(usage, { promptTokens: stepUsage.promptTokens, completionTokens: stepUsage.completionTokens, ...(stepUsage.cost === undefined ? {} : { cost: stepUsage.cost }) });
      counts.failed += 1;
      const reason = reasonOf(error);
      if (abort === undefined && reason.status !== undefined && FATAL_STATUSES.includes(reason.status)) abort = { unit: unit.id, reason };
      const key = options.keyOf?.(unit.id);
      const failure: FailureRecord = {
        t: "f",
        id: unit.id,
        ...(key === undefined ? {} : { key }),
        level: unit.level,
        members: [...unit.members],
        model: step.model,
        reason,
        attempts: (previous.get(unit.id)?.attempts ?? 0) + 1,
        calls,
        ...(stepUsage.promptTokens + stepUsage.completionTokens === 0 ? {} : { usage: { promptTokens: stepUsage.promptTokens, completionTokens: stepUsage.completionTokens, ...(stepUsage.cost === undefined ? {} : { cost: stepUsage.cost }) } }),
      };
      failures.set(unit.id, failure);
      await hooks.onFailure?.(failure, step);
      hooks.onStep?.({ step, outcome: "failed", calls, usage: stepUsage, error: reason.message });
      return;
    }
    // Only a fully answered unit is recorded: half a cycle would be a lie about the other half.
    await emit(produced, step);
    counts.llm += produced.length;
    counts.calls += calls;
    addUsage(usage, { promptTokens: stepUsage.promptTokens, completionTokens: stepUsage.completionTokens, ...(stepUsage.cost === undefined ? {} : { cost: stepUsage.cost }) });
    hooks.onStep?.({ step, outcome: "done", calls, usage: stepUsage });
  };

  const byLayer = new Map<number, PlanStep[]>();
  for (const step of plan.steps) {
    const bucket = byLayer.get(step.unit.layer);
    if (bucket === undefined) byLayer.set(step.unit.layer, [step]);
    else bucket.push(step);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const width = Math.max(1, hooks.concurrency);
  for (const layer of layers) {
    const steps = byLayer.get(layer) ?? [];
    // A small worker pool: `width` steps in flight, taken in plan order.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < steps.length) {
        const step = steps[next];
        next += 1;
        if (step !== undefined) await runStep(step);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, steps.length) }, worker));
    await hooks.onLayer?.(layer, owed());
  }

  return {
    get records() {
      return book.all();
    },
    counts: { records: book.size(), ...counts },
    usage,
    failures: owed(),
    aborted: abort === undefined ? undefined : { ...abort, notAttempted },
  };
}
