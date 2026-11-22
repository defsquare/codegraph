import {
  COMPLETION_TOKENS_PER_BLOCK,
  COMPLETION_TOKENS_PER_GLOSSARY_ENTRY,
  COMPLETION_TOKENS_PER_WORD,
  EXPLAIN_WALK,
  EXPLAIN_WALK_NAME,
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  LEVELS,
  PROMPT_VERSION,
  customizeExplain,
  explainRecords,
  explainWalkIdentity,
  insightsStorePathFor,
  parseExplainFile,
  type EntityInstruction,
  type ExplainFile,
  type InsightsHeader,
  type Selection,
  type WalkIdentity,
} from "@codegraph/insights";
import type { Selector } from "@codegraph/analyzer";
import type { ExplainOptions, RunFlags, SelectionFlags } from "../args.js";
import { UsageError, type ExitCode } from "../exit.js";
import type { IoSink } from "../io.js";
import { sidecarPathFor } from "../insights-paths.js";
import { asUsageError, instructionsOf, readJson } from "./walk-input.js";
import { realSeam, runWalk, type HeaderInputs, type RunWords, type WalkRun, type WalkSeam } from "./walk-run.js";

/**
 * `codegraph explain [model.jsonl] [--src DIR] [--out FILE] [--model SLUG] …`
 *
 * THE BUILT-IN WALK (PLAN.md §22): the Specy question asked of every unit,
 * bottom-up, into `<model>.insights.db` and its side-car. This file says only
 * what is explain's — its spec and how it may be customized, its defaults, its
 * store path, its header, its JSON kinds and its words; the run itself is the
 * shared runner's (walk-run.ts), the one `codegraph walk` runs on too.
 *
 * CUSTOMIZED, IT STAYS EXPLAIN: `--instructions`, the selection flags and
 * `--walk FILE` (a definition that may not change the task nor the answer)
 * add to its prompt or narrow what it asks; its kind, its store and its
 * blocks are explain's. With nothing to carry, the spec IS `EXPLAIN_WALK` and
 * the header gains no key, so a plain explain's bytes never move.
 */

export type { WalkFs as ExplainFs, WalkSeam as ExplainSeam, WalkStores as ExplainStores } from "./walk-run.js";
export { estimatedCost, realSeam } from "./walk-run.js";
export { sidecarPathFor };

/** Explain's `--json` kinds: they keep their names and bytes (PLAN.md §22.5). */
export const EXPLAIN_KINDS = {
  plan: "codegraph.explainPlan/1",
  estimate: "codegraph.explainEstimate/1",
  summary: "codegraph.explainSummary/1",
} as const;

const EXPLAIN_WORDS: RunWords = {
  command: "explain",
  planTitle: "explain plan",
  estimateTitle: "explain estimate",
  store: "insights store",
  sidecar: ".insights.jsonl",
  answered: "explained",
  keepBoth: "--out FILE keeps both",
};

/** What customizes explain, from `explain`'s flags or from `walk --walk explain`'s. */
export type ExplainInputs = Pick<RunFlags, "models" | "out" | "typed"> &
  SelectionFlags &
  Pick<ExplainOptions, "scope" | "terms" | "instructions" | "walkFile">;

/** How a command other than explain presents explain's run: its kinds and titles (`walk --walk explain`). */
export interface ExplainAs {
  readonly kinds: WalkRun["kinds"];
  readonly words: Pick<RunWords, "command" | "planTitle" | "estimateTitle">;
  /** Whether a customized explain's identity rides on the JSON documents (a walk's do; explain's keep their bytes). */
  readonly identity: boolean;
}

/**
 * Explain, as the runner runs it. A flag replaces the `--walk` file's key (PLAN.md §22.5); `--scope a,b` is
 * `--include id:a --include id:b`, compiled like any include under the walk's resolved view.
 */
export function explainRun(inputs: ExplainInputs, seam: WalkSeam, as?: ExplainAs): WalkRun {
  const file = inputs.walkFile === undefined ? undefined : explainFileOf(inputs.walkFile, seam);
  const flagInstructions = instructionsOf(inputs.instructions, seam.fs);
  const customization: { readonly instructions: string; readonly entities: readonly EntityInstruction[] } = {
    instructions: flagInstructions ?? file?.customization.instructions ?? "",
    entities: file?.customization.entities ?? [],
  };
  let identity: WalkIdentity | undefined;
  try {
    identity = explainWalkIdentity(customization);
  } catch (error) {
    throw asUsageError(error, inputs.walkFile ?? "explain's customization", new Map([["prompt.instructions", "--instructions"]]));
  }
  const format = explainRecords(identity);
  const out = inputs.out ?? sidecarPathFor(inputs.models[0] ?? "model.jsonl");

  const scoped = inputs.scope.map((id): Selector => ({ type: "id", id }));
  const include = scoped.length + inputs.include.length > 0 ? [...scoped, ...inputs.include] : (file?.selection.include ?? []);
  const exclude = inputs.exclude.length > 0 ? inputs.exclude : (file?.selection.exclude ?? []);
  const levels = inputs.levels ?? file?.selection.levels ?? LEVELS;
  const closure = inputs.closure ?? file?.selection.closure ?? "none";
  // Only the selection inputs `--scope` did not have are priced: `--scope` alone prints what it always printed.
  const priced = inputs.include.length > 0 || inputs.exclude.length > 0 || inputs.levels !== undefined || inputs.closure !== undefined || file !== undefined;

  return {
    words: { ...EXPLAIN_WORDS, ...as?.words },
    out,
    storePath: insightsStorePathFor(out),
    format,
    kinds: as?.kinds ?? EXPLAIN_KINDS,
    identity: as?.identity === true && identity !== undefined ? { name: identity.name, version: identity.version, digest: identity.digest } : undefined,
    context: { depth: inputs.typed.depth ?? file?.context.depth ?? 1, maxLines: inputs.typed.maxLines ?? file?.context.maxLines ?? 200 },
    terms: inputs.terms,
    priced,
    priceInJson: as !== undefined,
    completion: outputAssumption(),
    journal: true,
    spec: (env) => customizeExplain(EXPLAIN_WALK, customization, env),
    selection: (env): Selection | undefined => {
      // With nothing that filters, no predicate at all: the plan every explain before M21 made.
      if (include.length === 0 && exclude.length === 0 && levels.length === LEVELS.length) return undefined;
      const unknown = inputs.scope.filter((id) => !env.graph.has(id));
      if (unknown.length > 0) {
        throw new UsageError(
          `--scope names ${unknown.length === 1 ? "an id" : "ids"} the model does not declare: ${unknown.join(", ")}`,
          "Scope takes module or type ids exactly as the model renders them (see 'codegraph export --format json').",
        );
      }
      // Trivial members stay explain's: templated, never asked nor skipped.
      return { include, exclude, levels, closure, trivial: "ask" };
    },
    header: (run) => headerFor(run, identity),
  };
}

/** A `--walk FILE` handed to explain: read, and checked for what explain may not change, every fault with its path. */
function explainFileOf(path: string, seam: WalkSeam): ExplainFile {
  const json = readJson(seam.fs, path, "--walk");
  try {
    return parseExplainFile(json);
  } catch (error) {
    throw asUsageError(error, path);
  }
}

/** Explain's header; a customized explain's carries `walk` right after `kind` (schema order). */
function headerFor(run: HeaderInputs, identity: WalkIdentity | undefined): InsightsHeader {
  return {
    t: "header",
    kind: INSIGHTS_KIND,
    ...(identity === undefined ? {} : { walk: { name: EXPLAIN_WALK_NAME, version: identity.version, digest: identity.digest } }),
    generatedBy: INSIGHTS_GENERATOR,
    promptVersion: PROMPT_VERSION,
    metamodel: INSIGHTS_METAMODEL,
    models: { leaf: run.models.leaf, rollup: run.models.rollup },
    ...(run.provider === undefined ? {} : { provider: run.provider }),
    depth: run.depth,
    source: { paths: [...run.paths], langs: [...run.langs], view: { name: run.view.name, filters: [...run.view.filters] } },
  };
}

/** What explain's output figure assumes, from the constants it is computed with. */
function outputAssumption(): string {
  const { operation, type, module } = COMPLETION_TOKENS_PER_BLOCK;
  return `operation ${operation}, type ${type}, module ${module} tokens per block asked for, plus ${COMPLETION_TOKENS_PER_WORD} per word and ${COMPLETION_TOKENS_PER_GLOSSARY_ENTRY} per glossary entry asked to define (gpt-5.6-luna, reasoning included)`;
}

export async function explainCommand(flags: ExplainOptions, io: IoSink, seam: WalkSeam = realSeam()): Promise<ExitCode> {
  return runWalk(flags, explainRun(flags, seam), io, seam);
}
