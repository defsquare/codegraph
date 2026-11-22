import { selectorToJson, type Selector } from "@codegraph/analyzer";
import {
  DEFAULT_WALK_DEFINITION,
  EXPLAIN_WALK_DEFINITION,
  INSIGHTS_GENERATOR,
  PROMPT_VERSION,
  WALK_COMPLETION_TOKENS_PER_BLOCK,
  WALK_DEFINITION_KIND,
  WALK_RECORDS_KIND,
  answerDigestOf,
  compileDefinition,
  insightsStorePathFor,
  parseWalkDefinition,
  walkRecords,
  walkSidecarPathFor,
  type CompiledWalk,
  type JsonValue,
  type WalkDefinition,
  type WalkRecordsHeader,
} from "@codegraph/insights";
import { DEFAULT_TERMS, type WalkOptions } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { outLine, type IoSink } from "../io.js";
import { asUsageError, instructionsOf, readJson, realInputFs, textOf, type InputFs } from "./walk-input.js";
import type { RunWords, WalkRun, WalkSeam } from "./walk-run.js";

/**
 * `codegraph walk [model.jsonl] [--walk FILE|explain] [--prompt TEXT] [--include SEL]… [--name N] …`
 *
 * A WALK OF THE USER'S (PLAN.md §22): a `codegraph.walk/1` definition — a file,
 * the default one, or the flags alone — compiled into a spec and a selection
 * and run by the runner explain runs on, into the walk's OWN store
 * (`<model>.N.walk.db`) and side-car. `--walk explain` runs the built-in on
 * explain's store, as `codegraph explain` would, with this command's kinds.
 *
 * A FLAG REPLACES THE FILE'S KEY, AND THE RESULT IS WHAT IS DIGESTED: every
 * flag is folded into the definition's JSON before it is parsed, so an
 * override is validated with a path like any key of the file, and the digest
 * the store records is the effective definition's.
 *
 * THE RUNNER IS LOADED LAST: printing a definition, and refusing one, read no
 * model and need no provider, so they never pay for the provider SDK.
 */

/** A walk's `--json` kinds (PLAN.md §22.5): `walk: { name, version, digest }` rides on each. */
export const WALK_KINDS = {
  plan: "codegraph.walkPlan/1",
  estimate: "codegraph.walkEstimate/1",
  summary: "codegraph.walkSummary/1",
} as const;

/** `seam` undefined: the real one, made once the runner is loaded. */
export async function walkCommand(options: WalkOptions, io: IoSink, seam?: WalkSeam): Promise<ExitCode> {
  if (options.printDefinition !== undefined) {
    outLine(io, JSON.stringify(options.printDefinition === "explain" ? EXPLAIN_WALK_DEFINITION : DEFAULT_WALK_DEFINITION, null, 2));
    return EXIT.OK;
  }
  if (options.walk === "explain") {
    const [{ explainRun }, runner] = await Promise.all([import("./explain.js"), import("./walk-run.js")]);
    const used = seam ?? runner.realSeam();
    const as = { kinds: WALK_KINDS, words: { command: "walk", planTitle: "walk plan (explain)", estimateTitle: "walk estimate (explain)" }, identity: true } as const;
    return runner.runWalk(options, explainRun({ ...options, scope: [], terms: DEFAULT_TERMS, walkFile: undefined }, used, as), io, used);
  }
  const run = definedRun(compileDefinition(effectiveDefinition(options, seam?.fs ?? realInputFs())), options);
  const runner = await import("./walk-run.js");
  return runner.runWalk(options, run, io, seam ?? runner.realSeam());
}

/** The flags a definition key is replaced by, by the key's path: what a fault at that path is reported as coming from. */
type Folded = Map<string, string>;

const isObject = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `value` at `path` of `json`, made as it goes. A step through something that is not an object is left alone:
 * the file's own fault there is the one to report, and the parser reports it with its path.
 */
function fold(json: Record<string, JsonValue>, path: readonly string[], value: JsonValue | undefined, flag: string, folded: Folded): void {
  if (value === undefined) return;
  let at: Record<string, JsonValue> = json;
  for (const key of path.slice(0, -1)) {
    const next = at[key] ?? {};
    if (!isObject(next)) return;
    at = at[key] = { ...next };
  }
  at[path[path.length - 1] as string] = value;
  folded.set(path.join("."), flag);
}

/** Several terms are any of them; one is itself (as a file would spell it). */
function selectorJson(selectors: readonly Selector[]): JsonValue | undefined {
  if (selectors.length === 0) return undefined;
  const [only] = selectors;
  return (selectors.length === 1 && only !== undefined ? selectorToJson(only) : { any: selectors.map((selector) => selectorToJson(selector)) }) as JsonValue;
}

/** The definition the walk runs: the file's (or the default), every flag folded over its key, then parsed whole. */
export function effectiveDefinition(options: WalkOptions, fs: InputFs): WalkDefinition {
  const origin = options.walk ?? "the default definition with these flags";
  const raw = options.walk === undefined ? { kind: WALK_DEFINITION_KIND } : readJson(fs, options.walk, "--walk");
  const folded: Folded = new Map();
  const json: unknown = isObject(raw) ? { ...raw } : raw;
  if (isObject(json)) {
    fold(json, ["name"], options.name, "--name", folded);
    const task = options.prompt ?? (options.promptFile === undefined ? undefined : textOf(fs, options.promptFile, "--prompt-file"));
    fold(json, ["prompt", "task"], task, options.prompt === undefined ? "--prompt-file" : "--prompt", folded);
    fold(json, ["prompt", "instructions"], instructionsOf(options.instructions, fs), "--instructions", folded);
    fold(json, ["select"], selectorJson(options.include), "--include", folded);
    fold(json, ["exclude"], selectorJson(options.exclude), "--exclude", folded);
    fold(json, ["levels"], options.levels === undefined ? undefined : [...options.levels], "--levels", folded);
    fold(json, ["closure"], options.closure, "--closure", folded);
    fold(json, ["context", "depth"], options.typed.depth, "--depth", folded);
    fold(json, ["context", "maxLines"], options.typed.maxLines, "--max-lines", folded);
  }
  try {
    return parseWalkDefinition(json);
  } catch (error) {
    throw asUsageError(error, origin, folded);
  }
}

/** A defined walk, as the runner runs it: its own store and kinds, its selection always, its completion the measured table's. */
function definedRun(compiled: CompiledWalk, options: WalkOptions): WalkRun {
  const format = walkRecords(compiled);
  const out = options.out ?? walkSidecarPathFor(options.models[0] ?? "model.jsonl", compiled.name);
  const words: RunWords = {
    command: "walk",
    planTitle: `walk plan (${compiled.name})`,
    estimateTitle: `walk estimate (${compiled.name})`,
    store: `store of the walk "${compiled.name}"`,
    sidecar: `.${compiled.name}.walk.jsonl`,
    answered: "answered",
    keepBoth: "--name OTHER keeps both",
  };
  const answerDigest = answerDigestOf(compiled.answer);
  return {
    words,
    out,
    storePath: insightsStorePathFor(out),
    format,
    kinds: WALK_KINDS,
    identity: { name: compiled.name, version: compiled.version, digest: compiled.digest },
    context: { depth: compiled.context.depth, maxLines: compiled.context.maxLines },
    terms: DEFAULT_TERMS,
    priced: true,
    priceInJson: true,
    completion: outputAssumption(),
    journal: false,
    spec: (env) => compiled.spec(env),
    selection: () => compiled.selection,
    header: (run): WalkRecordsHeader => ({
      t: "header",
      kind: WALK_RECORDS_KIND,
      walk: { name: compiled.name, version: compiled.version, digest: compiled.digest, answerDigest },
      generatedBy: INSIGHTS_GENERATOR,
      promptVersion: PROMPT_VERSION,
      models: { leaf: run.models.leaf, rollup: run.models.rollup },
      ...(run.provider === undefined ? {} : { provider: run.provider }),
      depth: run.depth,
      source: { paths: [...run.paths], langs: [...run.langs], view: { name: run.view.name, filters: [...run.view.filters] } },
    }),
  };
}

/** What a defined walk's output figure assumes, from the table it is computed with; nothing measured a declared field. */
function outputAssumption(): string {
  const { operation, type } = WALK_COMPLETION_TOKENS_PER_BLOCK;
  return (
    `operation ${operation}, type ${type} tokens per block asked for ` +
    "(sonnet through claude-code, on a walk that declares no field: declared fields add to it; no module was measured, it takes the type's figure)"
  );
}
