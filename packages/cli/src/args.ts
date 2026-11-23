import { accessSync, constants } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  FOLD_LEVELS,
  FRAMEWORK_PROFILES,
  HOTSPOT_FAMILIES,
  SelectorError,
  parseTerm,
  type FoldLevel,
  type HotspotFamily,
  type Selector,
} from "@codegraph/analyzer";
import { CLOSURES, EXPLAIN_WALK_NAME, WALK_NAME_PATTERN, type Closure } from "@codegraph/insights";
import { METRIC_PREFIXES, SCALES, metricNames } from "@codegraph/city";
import { SCOPE_LEVELS, TERM_CLASSES, WEIGHT_KEYS, type ScopeLevel, type TermClass, type WeightKey } from "@codegraph/vocabulary";
import { defaultDataDir } from "./app/store.js";
import { UsageError } from "./exit.js";

export { UsageError } from "./exit.js";

/**
 * Argument parsing, with ZERO dependencies (M4 decision 1): Node 22 ships
 * `parseArgs` in `node:util`, so commander/yargs/minimist buy nothing here. The
 * CLI's dependency list stays exactly `@codegraph/core` + `@codegraph/analyzer`.
 *
 * THE OPTION SPECS ARE DATA. Help text, `parseArgs` configuration, required-ness
 * and value validation are all derived from the same `CommandSpec` objects, so
 * what `--help` promises and what the parser accepts cannot drift apart. Adding
 * an option means adding one entry to one array.
 */

export const COMMAND_NAMES = [
  "validate",
  "analyze",
  "import",
  "query",
  "export",
  "city",
  "navigator",
  "vocabulary",
  "serve",
  "domain-facts",
  "explain",
  "walk",
  "insights",
  "scm",
  "snapshots",
  "history",
  "timeline",
  "replay",
  "profiles",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** `analyze --report` values. */
export const REPORTS = ["deps", "cycles", "coupling", "wiring"] as const;
export type ReportName = (typeof REPORTS)[number];

/** `export --format` values. */
export const FORMATS = ["dot", "json", "csv", "plantuml"] as const;
export type FormatName = (typeof FORMATS)[number];

/**
 * `history --report` values. The last two are the CROSS-GRAPH reports (M9b):
 * they join the mined history with a model, so they read `--model` too. Since
 * M23b `hotspots` and `summary` join one WHEN `--model` is given, and are the
 * history's own reports when it is not.
 */
export const HISTORY_REPORTS = [
  "summary",
  "hotspots",
  "authors",
  "coupling",
  "hidden",
  "deadweight",
] as const;
export type HistoryReportName = (typeof HISTORY_REPORTS)[number];
export const DEFAULT_HISTORY_REPORT: HistoryReportName = "summary";

/**
 * `--level` values come from the analyzer's `FOLD_LEVELS`, never from a local
 * copy: a level the CLI offers but the analyzer cannot fold is a lie in the
 * help text.
 */
export const LEVELS: readonly FoldLevel[] = FOLD_LEVELS;
export const DEFAULT_LEVEL: FoldLevel = "module";

/** `analyze` with no `--report`: the dependency graph, the report the rest build on. */
export const DEFAULT_REPORT: ReportName = "deps";

export interface OptionSpec {
  /** The long flag exactly as typed, without `--` (`internal-only`). */
  readonly name: string;
  /** `boolean` takes no value; `string` takes one. Mirrors `parseArgs`. */
  readonly type: "boolean" | "string";
  readonly describe: string;
  readonly short?: string | undefined;
  /** Closed value set; anything else is a usage error naming these. */
  readonly choices?: readonly string[] | undefined;
  /** Missing it is a usage error. */
  readonly required?: boolean | undefined;
  /** Help placeholder for a free-form value (`FILE`, `N`). Ignored when `choices` is set. */
  readonly placeholder?: string | undefined;
  /** Parse the value as an integer >= 1; a non-integer is a usage error. */
  readonly integer?: boolean | undefined;
  /** Value used when the flag is absent, shown in the help text. */
  readonly defaultValue?: string | undefined;
  /** A string flag that may be given several times (`--include A --include B`): its values, in order. */
  readonly multiple?: boolean | undefined;
}

export interface PositionalSpec {
  /** Displayed name, e.g. `model.jsonl`. */
  readonly name: string;
  readonly describe: string;
  /** One or more (`<model.jsonl...>`). */
  readonly variadic: boolean;
  /** At least one must be given. */
  readonly required: boolean;
  /**
   * Used when nothing is typed. A thunk, not a string: the value depends on the
   * process's working directory, which is not known when the specs are built.
   */
  readonly defaultPath?: (() => string) | undefined;
  /** How to produce the default when it is missing — each artifact has its own maker. */
  readonly missingHint?: string | undefined;
  /**
   * ONE more positional after the first, always optional (`query <model.jsonl> [sql]`).
   * Never with `variadic`: a second argument must mean one thing.
   */
  readonly second?: { readonly name: string; readonly describe: string } | undefined;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
  /** Absent means the command takes no positional arguments at all. */
  readonly positional?: PositionalSpec | undefined;
  readonly options: readonly OptionSpec[];
}

const MODELS_POSITIONAL: PositionalSpec = {
  name: "model.jsonl",
  describe: "One or more model.jsonl paths, loaded together as ONE union (decision 5).",
  variadic: true,
  required: true,
};

/**
 * `<current-dir>-codegraph.jsonl` — exactly what `codegraph-java` writes when it
 * is run bare. The two halves of the pipeline agree on one file name so that
 * standing in a corpus and typing the command is the whole workflow; the name
 * carries the directory so several models can share a downloads folder.
 */
export function defaultModelPath(): string {
  const directory = basename(resolve("."));
  return directory.length === 0 ? "codegraph.jsonl" : `${directory}-codegraph.jsonl`;
}

/** `<current-dir>-history.jsonl` — exactly what `codegraph scm .` writes here. */
export function defaultHistoryPath(): string {
  const directory = basename(resolve("."));
  return directory.length === 0 ? "history.jsonl" : `${directory}-history.jsonl`;
}

/** The same models, defaulted: for the commands run against the corpus at hand. */
const MODELS_POSITIONAL_DEFAULTED: PositionalSpec = {
  ...MODELS_POSITIONAL,
  required: false,
  defaultPath: defaultModelPath,
};

const JSON_OPTION: OptionSpec = {
  name: "json",
  type: "boolean",
  describe: "Print the same information as a machine-readable JSON object on stdout.",
};

const VIEW_OPTIONS: readonly OptionSpec[] = [
  {
    name: "internal-only",
    type: "boolean",
    describe: "Drop stub (external) entities and every edge touching one.",
  },
  {
    name: "declared-only",
    type: "boolean",
    describe: "Keep only `declared` facts; drop derived and dynamic-candidate edges.",
  },
];

/**
 * The store is a CACHE: derived, disposable, and rebuilt whenever the model it
 * describes has changed. `--no-cache` is the escape hatch for anyone who would
 * rather not rely on size-and-mtime staleness, or who cannot write beside the
 * model — though the latter degrades on its own.
 */
const NO_CACHE_OPTION: OptionSpec = {
  name: "no-cache",
  type: "boolean",
  describe: "Read the model.jsonl directly; never build or reuse a sibling model.db.",
};

const LEVEL_OPTION: OptionSpec = {
  name: "level",
  type: "string",
  describe: "Fold the graph to this level before reporting.",
  choices: LEVELS,
  defaultValue: DEFAULT_LEVEL,
};

export const VALIDATE_SPEC: CommandSpec = {
  name: "validate",
  summary: "Check models against their language profile and the graph invariants.",
  positional: MODELS_POSITIONAL,
  options: [JSON_OPTION],
};

export const ANALYZE_SPEC: CommandSpec = {
  name: "analyze",
  summary: "Report dependencies, cycles, coupling or framework wiring over the loaded models.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    {
      name: "report",
      type: "string",
      describe: "Which analysis to run.",
      choices: REPORTS,
      defaultValue: DEFAULT_REPORT,
    },
    LEVEL_OPTION,
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
    {
      name: "top",
      type: "string",
      describe: "Show only the N highest-ranked rows.",
      placeholder: "N",
      integer: true,
    },
    JSON_OPTION,
  ],
};

export const EXPORT_SPEC: CommandSpec = {
  name: "export",
  summary: "Write the folded graph as DOT, JSON, CSV or PlantUML.",
  positional: MODELS_POSITIONAL,
  options: [
    {
      name: "format",
      type: "string",
      describe: "Output format.",
      choices: FORMATS,
      required: true,
    },
    LEVEL_OPTION,
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
    {
      name: "out",
      type: "string",
      describe: "Write the artifact to this file instead of stdout.",
      placeholder: "FILE",
    },
  ],
};

/**
 * `codegraph city --height / --footprint` take a metric NAME, not a closed set:
 * `attribute:` and `sum:` are open by design (an extractor may measure anything,
 * complexity included). The help therefore lists what exists rather than
 * constraining what may be typed, and lists it from the registry itself.
 */
function metricHelp(channel: string): string {
  return (
    `Metric driving ${channel}. Built in: ${metricNames().join(", ")}. ` +
    `Open forms: ${METRIC_PREFIXES.map((form) => `${form.prefix}<key>`).join(", ")}. ` +
    `With a change-history side-car: history:<measure> (the type's own), history-file:<measure> (its file). ` +
    `From the names: vocabulary:<word> (the word's weight in the type's names).`
  );
}

/**
 * The channels of the city — shared by `city` (which writes the artifact) and
 * `serve` (which builds it for the page), so the two cannot offer different
 * metrics for the same building.
 */
const CITY_CHANNEL_OPTIONS: readonly OptionSpec[] = [
    {
      name: "height",
      type: "string",
      describe: metricHelp("building height"),
      placeholder: "METRIC",
      defaultValue: "loc",
    },
    {
      name: "height-scale",
      type: "string",
      describe: "How height follows its metric.",
      choices: SCALES,
      defaultValue: "linear",
    },
    {
      name: "footprint",
      type: "string",
      describe: metricHelp("building footprint"),
      placeholder: "METRIC",
      defaultValue: "members",
    },
    {
      name: "footprint-scale",
      type: "string",
      describe: "How the footprint SIDE follows its metric; sqrt makes the AREA proportional.",
      choices: SCALES,
      defaultValue: "sqrt",
    },
    {
      name: "carry",
      type: "string",
      describe: "Extra metrics to measure onto every building, comma-separated, bound to nothing.",
      placeholder: "M1,M2",
    },
    {
      name: "history-metrics",
      type: "string",
      describe:
        "The change-history side-car the history:/history-file: metrics read (what " +
        "'codegraph-metrics --history' wrote). Default: <model>.history-metrics.jsonl beside each model.",
      placeholder: "FILE",
    },
    {
      name: "framework",
      type: "string",
      describe:
        "Classify types by a framework's own vocabulary (service, repository, " +
        "controller…) and offer it as a color channel. An inference from " +
        "written annotations; absent means the city says nothing about roles.",
      choices: Object.keys(FRAMEWORK_PROFILES),
      placeholder: "NAME",
    },
];

/** `--name STR`, the corpus label a frontend shows in its header. */
const CORPUS_NAME_OPTION: OptionSpec = {
  name: "name",
  type: "string",
  describe: "Display name for the corpus in the page header; defaults to the basename of each model's root.",
  placeholder: "STR",
};

export const CITY_SPEC: CommandSpec = {
  name: "city",
  summary: "Write the code city: modules as districts, types as buildings.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    ...CITY_CHANNEL_OPTIONS,
    CORPUS_NAME_OPTION,
    {
      name: "layout",
      type: "boolean",
      describe:
        "Lay the city out: positions on buildings, bounds on districts, by recursive shelf packing.",
    },
    ...VIEW_OPTIONS,
    {
      name: "out",
      type: "string",
      describe: "Write the artifact to this file instead of stdout.",
      placeholder: "FILE",
    },
  ],
};

/**
 * `codegraph navigator`: the browsable model — a tree panel plus a fan-in /
 * fan-out dependency view per node. Same shape as `city`: the transform lives
 * in `@codegraph/navigator`, the frontend is `@codegraph/navigator-ui`'s
 * prebuilt bundle, and this command only resolves flags and moves bytes.
 */
export const NAVIGATOR_SPEC: CommandSpec = {
  name: "navigator",
  summary: "Write the navigator model: the browsable tree with one classified row per dependency.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    CORPUS_NAME_OPTION,
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
    {
      name: "out",
      type: "string",
      describe: "Write the artifact to this file instead of stdout.",
      placeholder: "FILE",
    },
  ],
};

/** `vocabulary --class`: one of the package's classes, or every one. */
export const VOCABULARY_CLASSES = [...TERM_CLASSES, "all"] as const;
export type VocabularyClass = (typeof VOCABULARY_CLASSES)[number];

/**
 * `codegraph vocabulary`: the words the model's names are made of (PLAN.md
 * §20.1). The counts are `@codegraph/vocabulary`'s; this command picks the
 * scope, the class and the report, and writes the artifact on `--out`.
 */
export const VOCABULARY_SPEC: CommandSpec = {
  name: "vocabulary",
  summary: "Report the words the model's names are made of, per corpus, module or type; or drift against a glossary.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    {
      name: "level",
      type: "string",
      describe: "The corpus's words, or one block per module or type, ranked by distinct terms (the cognitive-load report).",
      choices: SCOPE_LEVELS,
      defaultValue: "corpus",
    },
    {
      name: "scope",
      type: "string",
      describe: "Report one scope: a module or type by its entity id, or an operation, counted on demand.",
      placeholder: "ID",
    },
    {
      name: "top",
      type: "string",
      describe: "Show the N heaviest words: 40 by default, 10 per block under --level module|type.",
      placeholder: "N",
      integer: true,
    },
    {
      name: "class",
      type: "string",
      describe: "Which words to show.",
      choices: VOCABULARY_CLASSES,
      defaultValue: "domain",
    },
    {
      name: "weights",
      type: "string",
      describe: `Override weights, e.g. type=6,qualifier=0. Keys: ${WEIGHT_KEYS.join(", ")}.`,
      placeholder: "KEY=N,…",
    },
    {
      name: "technical",
      type: "string",
      describe: "Replace the shared technical words with this file's, one word per line; each language's own still apply.",
      placeholder: "FILE",
    },
    {
      name: "drift",
      type: "string",
      describe:
        "Compare with a glossary, one business term per line: the terms no scope of --level says (exit 3), and the domain words no term contains.",
      placeholder: "FILE",
    },
    {
      name: "drift-insights",
      type: "boolean",
      describe:
        "Compare the words' classes with what 'codegraph explain' judged them: the technical words a model called domain somewhere, " +
        "and the reverse, with the entities; with --drift, the business terms against both.",
    },
    {
      name: "insights",
      type: "string",
      describe: "The insights store --drift-insights reads. Default: <model>.insights.db beside the first model.",
      placeholder: "FILE",
    },
    {
      name: "out",
      type: "string",
      describe: "Also write the vocabulary.json artifact to this file.",
      placeholder: "FILE",
    },
    {
      name: "svg",
      type: "string",
      describe: "Also draw one scope's cloud to this SVG file: the corpus, or the --scope one; --class and --top pick its words.",
      placeholder: "FILE",
    },
    JSON_OPTION,
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
  ],
};

/**
 * `codegraph serve`: ONE PAGE over a model — the navigator (tree, evidence,
 * graph, cycles, coupling) with the 3D city as one of its tabs. Both
 * artifacts are built from the same graph under the same view, so a building
 * clicked in the city is the entity the tree reveals. The transforms live in
 * `@codegraph/navigator` and `@codegraph/city`; the frontend is
 * `@codegraph/navigator-ui`'s prebuilt bundle, which embeds `@codegraph/viz`.
 */
export const SERVE_SPEC: CommandSpec = {
  name: "serve",
  summary: "Serve the navigator with the code city as a tab, over this model.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    CORPUS_NAME_OPTION,
    ...CITY_CHANNEL_OPTIONS,
    {
      name: "port",
      type: "string",
      describe: "Port to listen on; 0 picks a free one (announced on stderr).",
      placeholder: "N",
      defaultValue: "4177",
    },
    {
      name: "host",
      type: "string",
      describe:
        "Address to bind. 0.0.0.0 is every interface, so the page is reachable " +
        "from other machines; 127.0.0.1 keeps it to this one.",
      placeholder: "ADDR",
      defaultValue: "0.0.0.0",
    },
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
    {
      name: "app",
      type: "boolean",
      describe:
        "The desktop app's daemon: no model on argv; bind 127.0.0.1:0 under a per-launch " +
        "token, print one JSON line {port, token} on stdout, open folders through POST /jobs, " +
        "exit when stdin closes.",
    },
    {
      name: "data-dir",
      type: "string",
      describe:
        "With --app: where models, their model.db caches, the page's artifacts and the recents " +
        "live (default: the OS application-data directory, under codegraph/).",
      placeholder: "DIR",
    },
    {
      name: "extractors",
      type: "string",
      describe:
        "With --app: the extractor registry, a JSON list of " +
        "{ name, path, extensions[], launch?, env? } — the daemon runs an entry, never a language.",
      placeholder: "FILE",
    },
    {
      name: "insights",
      type: "string",
      describe:
        "The insights store behind the page's explanation panel and the Vocabulary tab's glossary (what 'codegraph explain' wrote), or a walk's store (what 'codegraph walk' wrote: the panel shows the walk's answers, the glossary has none). " +
        "Default: <model>.insights.db beside the first model; with none, or one an older codegraph wrote that no 'codegraph explain' has migrated yet, the page shows no explanations.",
      placeholder: "FILE",
    },
  ],
};

/** The options `--app` adds to `serve`: the daemon's data directory and registry. */
export interface AppOptions {
  readonly dataDir: string;
  /** `--extractors FILE`; undefined means an empty registry — only model.jsonl files open. */
  readonly extractors: string | undefined;
}

/**
 * `codegraph domain-facts`: the per-type dossier artifact for domain-extraction
 * consumers — every fact the model holds about a type, pre-joined (annotations
 * with arguments, operations with their invocations/accesses/throw sites,
 * framework roles, module imports). The transform lives in the analyzer
 * (`buildDomainFacts`); this command only resolves flags and moves bytes.
 */
export const DOMAIN_FACTS_SPEC: CommandSpec = {
  name: "domain-facts",
  summary: "Write per-type domain dossiers: joined facts for domain extraction.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    {
      name: "framework",
      type: "string",
      describe:
        "Classify types and entry points by a framework's own vocabulary and attach " +
        "DI candidates to each dossier. An inference from written annotations; " +
        "absent means the dossiers say nothing about roles.",
      choices: Object.keys(FRAMEWORK_PROFILES),
      placeholder: "NAME",
    },
    ...VIEW_OPTIONS,
    NO_CACHE_OPTION,
    {
      name: "out",
      type: "string",
      describe: "Write the artifact to this file instead of stdout.",
      placeholder: "FILE",
    },
  ],
};

/** `--model` on the key providers (OpenRouter, Cloudflare), in their `author/model` form. */
export const DEFAULT_EXPLAIN_MODEL = "openai/gpt-5.6-luna";
/**
 * `--model` on claude-code: Claude Code's alias for the latest Sonnet. Restated from
 * @codegraph/llm's CLAUDE_CODE_DEFAULT_MODEL and pinned equal by a test: parsing must
 * not load the provider package (and with it the SDK) for every command.
 */
export const DEFAULT_CLAUDE_CODE_MODEL = "sonnet";
/** `--terms`: the words a module's glossary reconciles — explain's; a walk asks none and passes it unchanged. */
export const DEFAULT_TERMS = 60;
/** `--provider` values: the three adapters of @codegraph/llm, or pick from the environment. */
export const EXPLAIN_PROVIDERS = ["auto", "openrouter", "cloudflare", "claude-code"] as const;
export type ExplainProvider = (typeof EXPLAIN_PROVIDERS)[number];

/**
 * THE RUN FLAGS `explain` AND `walk` SHARE (PLAN.md §22.5): one table, both
 * commands' options built from it (`runOptions`), so a flag added to one is a
 * flag of both. Each command's own flags go after `--max-scc`; a walk restates
 * a few descriptions in its own words (`WALK_WORDING`), never the flag list.
 */
const RUN_OPTIONS: readonly OptionSpec[] = [
  {
    name: "src",
    type: "string",
    describe:
      "The source root the model's anchors are relative to. Defaults to the model's own " +
      "`root`, resolved against the current directory.",
    placeholder: "DIR",
  },
  {
    name: "out",
    type: "string",
    describe: "The side-car to write (and to resume from). Defaults to <model>.insights.jsonl.",
    placeholder: "FILE",
  },
  {
    name: "provider",
    type: "string",
    describe:
      "Where the model calls go: openrouter (OPENROUTER_API_KEY), cloudflare — Cloudflare AI " +
      "Gateway's REST API (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, optional " +
      "CLOUDFLARE_AI_GATEWAY_ID) — or claude-code, the local Claude Code CLI in headless mode " +
      "(`claude -p`, Sonnet by default, no key). auto picks whichever is configured; with " +
      "several, OpenRouter, then Cloudflare, then Claude Code.",
    choices: [...EXPLAIN_PROVIDERS],
    placeholder: "NAME",
    defaultValue: "auto",
  },
  {
    name: "claude-path",
    type: "string",
    describe:
      "The Claude Code binary. Under --provider auto it implies claude-code; with openrouter or " +
      "cloudflare it is an error. Otherwise CLAUDE_CODE_PATH, then `claude` on PATH, then the known " +
      "install locations; a path that does not exist is an error, never a fall-through.",
    placeholder: "FILE",
  },
  {
    name: "model",
    type: "string",
    describe:
      `Model slug for operations (the leaves). Defaults per provider: ${DEFAULT_EXPLAIN_MODEL} ` +
      `(author/model form) on openrouter and cloudflare, ${DEFAULT_CLAUDE_CODE_MODEL} on claude-code ` +
      "— an alias Claude Code resolves to the latest Sonnet; a full id such as claude-sonnet-5-5 " +
      "pins the fingerprint.",
    placeholder: "SLUG",
  },
  {
    name: "rollup-model",
    type: "string",
    describe: "Model slug for types and modules; defaults to --model.",
    placeholder: "SLUG",
  },
  {
    name: "depth",
    type: "string",
    describe: "How many levels of dependency explanations a prompt carries.",
    placeholder: "N",
    integer: true,
    defaultValue: "1",
  },
  {
    name: "max-calls",
    type: "string",
    describe: "Stop planning model calls after this many; what runs is a dependency-consistent prefix.",
    placeholder: "N",
    integer: true,
  },
  {
    name: "max-tokens",
    type: "string",
    describe:
      "Cap on the tokens one answer may use (reasoning included). Omitted, the provider assumes " +
      "the model's full output window and a prepaid account must afford THAT for every call; a " +
      "block is ~1k tokens, a full cycle call ~12k. An answer cut at the cap fails its unit. " +
      "Does not apply to claude-code (the CLI has no output cap): noted on stderr, ignored.",
    placeholder: "N",
    integer: true,
  },
  {
    name: "concurrency",
    type: "string",
    describe: "Model calls in flight at once.",
    placeholder: "N",
    integer: true,
    defaultValue: "4",
  },
  {
    name: "max-lines",
    type: "string",
    describe: "Source lines shown per unit before the middle is elided.",
    placeholder: "N",
    integer: true,
    defaultValue: "200",
  },
  {
    name: "max-scc",
    type: "string",
    describe: "Members of a dependency cycle explained in one call; larger cycles are chunked.",
    placeholder: "N",
    integer: true,
    defaultValue: "12",
  },
  {
    name: "framework",
    type: "string",
    describe: "Add a framework's stereotypes and entry points to the facts shown.",
    choices: Object.keys(FRAMEWORK_PROFILES),
    placeholder: "NAME",
  },
  ...VIEW_OPTIONS,
  NO_CACHE_OPTION,
  {
    name: "dry-run",
    type: "boolean",
    describe: "Print the plan — units, order, statuses, estimated tokens — and make no call.",
  },
  {
    name: "estimate",
    type: "boolean",
    describe:
      "Print the token volume this run would send and receive (input and output, per level) " +
      "and make no call. Add --price-in/--price-out for a cost.",
  },
  {
    name: "price-in",
    type: "string",
    describe: "Input price in USD per million tokens, for the estimate's cost line.",
    placeholder: "USD",
  },
  {
    name: "price-out",
    type: "string",
    describe: "Output price in USD per million tokens, for the estimate's cost line.",
    placeholder: "USD",
  },
  {
    name: "force",
    type: "boolean",
    describe: "Re-explain every unit, ignoring records whose fingerprint still matches.",
  },
  {
    name: "retry-failed",
    type: "boolean",
    describe:
      "Redo only the units the side-car records as failed (its `t:\"f\"` lines, each with the " +
      "reason), plus their direct dependents, which were explained without them. Everything " +
      "else is reused or left alone. Pass the same --model/--depth as the run that failed.",
  },
  {
    name: "export",
    type: "boolean",
    describe:
      "Write the side-car from the insights store (<model>.insights.db) and stop: no model is " +
      "read, no call is made. Every run ends with this export; use it after an interrupted one.",
  },
  {
    name: "import",
    type: "string",
    describe:
      "REPLACE the insights store's records with those of a side-car (one edited by hand, or " +
      "one from another machine) and stop. Asks first when the store holds records; --yes skips it.",
    placeholder: "FILE",
  },
  {
    name: "yes",
    type: "boolean",
    short: "y",
    describe:
      "Run without asking. Otherwise a run that makes model calls prints its token estimate " +
      "and waits for confirmation — which needs an interactive terminal.",
  },
  JSON_OPTION,
];

/** The run flags with a command's own after `--max-scc`, each description reworded where `wording` says. */
function runOptions(own: readonly OptionSpec[], wording: Readonly<Record<string, Partial<OptionSpec>>> = {}): readonly OptionSpec[] {
  const at = RUN_OPTIONS.findIndex((option) => option.name === "max-scc") + 1;
  return [...RUN_OPTIONS.slice(0, at), ...own, ...RUN_OPTIONS.slice(at)].map((option) => ({ ...option, ...wording[option.name] }));
}

/** `--closure` values, the selection's (PLAN.md §22.3 rule 4). */
export const WALK_CLOSURES: readonly Closure[] = CLOSURES;

/** The selection flags both commands take (PLAN.md §22.5): each an analyzer selector term, compiled by the walk's view. */
const SELECTION_OPTIONS: readonly OptionSpec[] = [
  {
    name: "include",
    type: "string",
    multiple: true,
    describe:
      "Ask only the units whose member — itself, its nearest type or its nearest module — matches this selector term: " +
      "id:ID, kind:K, trait:T, lang:L, name:GLOB, module:GLOB, file:GLOB, edge:KIND[>TERM], edge-in:KIND[<TERM]. " +
      "Repeatable: several are any of them. The walk is still built over the whole model.",
    placeholder: "SEL",
  },
  {
    name: "exclude",
    type: "string",
    multiple: true,
    describe: "Never ask a unit whose member (itself, its nearest type or module) matches this term; wins over --include. Repeatable.",
    placeholder: "SEL",
  },
  {
    name: "levels",
    type: "string",
    describe: "Comma-separated levels to ask: operation, type, module (all three unless given).",
    placeholder: "LEVELS",
  },
  {
    name: "closure",
    type: "string",
    describe:
      "Also ask what the selection leans on: dependencies (every unit it depends on, so each asked prompt sees its " +
      "callees answered), containers (the type and module above it), all (both). none unless given.",
    choices: CLOSURES,
  },
];

const INSTRUCTIONS_OPTION: OptionSpec = {
  name: "instructions",
  type: "string",
  describe:
    "Instructions added to every unit's system message, after the task (a definition's prompt.instructions); " +
    "@FILE reads them from a file. Every unit asked under them is asked again when they change.",
  placeholder: "TEXT|@FILE",
};

export const EXPLAIN_SPEC: CommandSpec = {
  name: "explain",
  summary: "Explain every operation, type and module with an LLM, bottom-up, into a side-car.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: runOptions([
    {
      name: "terms",
      type: "string",
      describe: "Words a module's glossary reconciles: the heaviest N its types define.",
      placeholder: "N",
      integer: true,
      defaultValue: "60",
    },
    {
      name: "scope",
      type: "string",
      describe:
        "Comma-separated module or type ids: explain only units inside them (dependencies outside " +
        "are reused when already explained, never called).",
      placeholder: "IDS",
    },
    ...SELECTION_OPTIONS,
    INSTRUCTIONS_OPTION,
    {
      name: "walk",
      type: "string",
      describe:
        "A codegraph.walk/1 file customizing explain: select, exclude, levels, closure, context, prompt.instructions " +
        "and prompt.entities (never prompt.task, answer, trivial, another name or version: explain's answer is the " +
        "Specy blocks). A flag replaces the file's key. `codegraph walk --print-definition explain` prints one.",
      placeholder: "FILE",
    },
  ]),
};

/** A walk's words for the run flags whose descriptions name explain's files or explain's verb. */
const WALK_WORDING: Readonly<Record<string, Partial<OptionSpec>>> = {
  out: { describe: "The side-car to write (and to resume from). Defaults to <model>.N.walk.jsonl, N the walk's name; its store is the same path with .db." },
  depth: { describe: "How many levels of dependency answers a prompt carries. Replaces the definition's context.depth (1 by default).", defaultValue: undefined },
  "max-lines": { describe: "Source lines shown per unit before the middle is elided. Replaces the definition's context.maxLines (200 by default).", defaultValue: undefined },
  "max-scc": { describe: "Members of a dependency cycle asked in one call; larger cycles are chunked." },
  force: { describe: "Ask every selected unit again, ignoring records whose fingerprint still matches." },
  "retry-failed": {
    describe:
      "Redo only the units the walk's store records as failed, plus their direct dependents, which were answered " +
      "without them; the selection is theirs, so no selection flag goes with it. Pass the same --model/--depth.",
  },
  export: { describe: "Write the side-car from the walk's store (<model>.N.walk.db) and stop: no model is read, no call is made." },
  import: { describe: "REPLACE the walk's store's records with those of one of its side-cars and stop. Asks first when the store holds records; --yes skips it." },
};

export const WALK_SPEC: CommandSpec = {
  name: "walk",
  summary: "Ask a question of every selected unit, bottom-up, with an LLM: a prompt or a walk definition, into its own store.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    {
      name: "walk",
      type: "string",
      describe:
        "The walk to run: a codegraph.walk/1 definition file, or `explain`, the built-in (explain's spec, store and " +
        "defaults). Neither: the default definition (name adhoc), asking --prompt.",
      placeholder: "FILE|explain",
    },
    {
      name: "prompt",
      type: "string",
      describe: "The task asked of every unit, at every level (replaces the definition's prompt.task).",
      placeholder: "TEXT",
    },
    {
      name: "prompt-file",
      type: "string",
      describe: "The same task, read from a file.",
      placeholder: "FILE",
    },
    INSTRUCTIONS_OPTION,
    {
      name: "name",
      type: "string",
      describe:
        "The walk's name (replaces the definition's name): its store is <model>.N.walk.db. A store is only ever " +
        "opened by the walk that wrote it, so --name OTHER keeps two definitions' answers apart. explain and insights are reserved.",
      placeholder: "N",
    },
    {
      name: "print-definition",
      type: "boolean",
      describe: "Print the default walk definition as JSON — or, followed by `explain`, explain's — and stop: a file to start from. No model is read.",
    },
    ...runOptions(SELECTION_OPTIONS, WALK_WORDING),
  ],
};

/** `insights --level` values: the three levels of the walk, as the side-car spells them. */
export const INSIGHT_LEVELS = ["operation", "type", "module"] as const;
export type InsightLevel = (typeof INSIGHT_LEVELS)[number];

/**
 * `codegraph insights`: the first READER of the insights store (PLAN.md §17.3,
 * M16c). It opens `<model>.insights.db` and nothing else — not the model, not
 * the side-car, no provider — so the positional only says WHICH store. A walk's
 * store, `<model>.N.walk.db`, is read with `--walk N` (PLAN.md §22.5).
 */
export const INSIGHTS_SPEC: CommandSpec = {
  name: "insights",
  summary: "Query what `explain` — or a walk, --walk N — has written: a summary, a list, one explanation, the words and their glossary, the run ledger.",
  positional: {
    name: "model.jsonl",
    describe: "The model whose insights store (<model>.insights.db, beside it) to read. The model itself is not opened.",
    variadic: false,
    required: false,
    defaultPath: defaultModelPath,
  },
  options: [
    {
      name: "store",
      type: "string",
      describe:
        "Read this store instead of the one beside the model (explain --out FILE puts it at FILE with .db for .jsonl) — " +
        "explain's or a walk's, as its header says, unless --walk names whose it must be.",
      placeholder: "FILE",
    },
    {
      name: "walk",
      type: "string",
      describe:
        "Read the store of the walk N (<model>.N.walk.db, beside the model) instead of explain's: its answers and fields, " +
        "listed and shown as they are; a concept or words, which only explain asks for, are none. 'explain' is the default.",
      placeholder: "N",
    },
    {
      name: "id",
      type: "string",
      describe:
        "Print ONE explanation in full — envelope, description, block — for this entity id, exactly as the model " +
        "renders it. An id that failed is answered with the reason (exit 3).",
      placeholder: "ID",
    },
    {
      name: "level",
      type: "string",
      describe: "List the records of one level.",
      choices: INSIGHT_LEVELS,
    },
    {
      name: "concept",
      type: "string",
      describe: "List the TYPES the model classified as this domain concept (aggregate, entity, valueType, repository…).",
      placeholder: "NAME",
    },
    {
      name: "min-confidence",
      type: "string",
      describe: "List records whose confidence is at least this (0 to 1).",
      placeholder: "X",
    },
    {
      name: "max-confidence",
      type: "string",
      describe: "List records whose confidence is at most this — what deserves a second look.",
      placeholder: "X",
    },
    {
      name: "limit",
      type: "string",
      describe: "Stop a list after N rows (side-car order: operations, types, modules, by id).",
      placeholder: "N",
      integer: true,
    },
    {
      name: "word",
      type: "string",
      describe:
        "List every explained entity whose names spell this word (split as 'codegraph vocabulary' splits names: lowercase), " +
        "by module: the module's glossary entry, then the module, its types, its operations — each with the concern, " +
        "confidence and sense the model gave the word there, and the identifiers it is in. One index lookup.",
      placeholder: "WORD",
    },
    {
      name: "glossary",
      type: "string",
      describe:
        "Print a module's glossary whole: each word its types spell, with the concern, sense and meaning the module " +
        "reconciled from them, and the types' own senses where they disagree.",
      placeholder: "MODULE_ID",
    },
    {
      name: "polysemy",
      type: "boolean",
      describe:
        "List the words a module flagged as meaning different things to its types, and the words two modules' glossaries " +
        "define differently: every module's entry, side by side, the most senses first.",
    },
    {
      name: "concerns",
      type: "boolean",
      describe: "Per module: how many distinct words its records define, and how many the model judged domain, technical, ambiguous.",
    },
    {
      name: "failures",
      type: "boolean",
      describe: "List the units still owed an explanation, with the reason each one failed.",
    },
    {
      name: "runs",
      type: "boolean",
      describe: "Print the run ledger, oldest first: when, which models, what each run explained and spent.",
    },
    JSON_OPTION,
  ],
};

/**
 * A store holds ONE model. Surrogates are file-scoped and are not identity
 * (MM-1), so unioning several models into one database would mean renumbering
 * them — and a renumbered corpus is a repointed one. Several paths are still
 * accepted: each becomes its own sibling `.db`, which is a loop, not a union.
 */
export const IMPORT_SPEC: CommandSpec = {
  name: "import",
  summary: "Build the SQLite analysis store (model.db) beside a model.jsonl.",
  positional: {
    name: "model.jsonl",
    describe: "One or more model.jsonl paths. Each becomes its OWN store — never a union.",
    variadic: true,
    required: true,
  },
  options: [
    {
      name: "out",
      type: "string",
      describe: "Write the store here instead of beside the model. One model only.",
      placeholder: "FILE",
    },
    {
      name: "at",
      type: "string",
      describe:
        "Append this model as the snapshot extracted at commit SHA — the temporal " +
        "store: revisions accumulate, and the flat tables mirror the latest import.",
      placeholder: "SHA",
    },
    {
      name: "time",
      type: "string",
      describe: "Commit time for --at (unix seconds or an ISO date); queries order by it.",
      placeholder: "T",
    },
    JSON_OPTION,
  ],
};

/** `query` prints this many rows unless told otherwise: a result is read, not scrolled. */
export const DEFAULT_QUERY_LIMIT = 50;

/** The three ways `query` writes its rows. */
export const QUERY_FORMATS = ["table", "json", "csv"] as const;
export type QueryFormat = (typeof QUERY_FORMATS)[number];

/**
 * `codegraph query`: one read-only SQL statement over a model's store (PLAN.md
 * §24.4). It exists so that no step of the discovery walk needs `sqlite3` on
 * the machine: the SQLite that builds the store is already in this binary.
 *
 * The model is REQUIRED and comes first, unlike the commands that default it:
 * with an optional statement after it, a lone argument could be either, and a
 * command that guesses which is a command that runs the wrong thing.
 */
export const QUERY_SPEC: CommandSpec = {
  name: "query",
  summary: "Run one read-only SQL statement over a model's store, with the node and dep views.",
  positional: {
    name: "model.jsonl",
    describe:
      "The model to query, through its store (model.db, built beside it when missing or stale) — or a model.db itself.",
    variadic: false,
    required: true,
    second: {
      name: "sql",
      describe:
        "The statement, quoted: ONE statement beginning with SELECT, WITH, VALUES or EXPLAIN. " +
        "The views node (one row per entity, with its rendered id) and dep (one row per edge, names resolved) are there.",
    },
  },
  options: [
    {
      name: "file",
      type: "string",
      describe: "Read the statement from this file instead of the command line.",
      placeholder: "FILE",
    },
    {
      name: "param",
      type: "string",
      describe:
        "Bind :NAME in the statement to VALUE — bound, never pasted into the text, so an id needs no escaping. " +
        "Repeat it per parameter. A whole or decimal number is bound as a number, anything else as text.",
      placeholder: "NAME=VALUE",
      multiple: true,
    },
    {
      name: "param-file",
      type: "string",
      describe:
        "Bind :NAME to the whole text of FILE, as text: a result saved with --json, a list. " +
        "json_each(:NAME, '$.rows') then reads the saved rows, so one statement builds on another's file.",
      placeholder: "NAME=FILE",
      multiple: true,
    },
    {
      name: "limit",
      type: "string",
      describe: "Print at most N rows; how many there were is said on stderr.",
      placeholder: "N",
      integer: true,
      defaultValue: String(DEFAULT_QUERY_LIMIT),
    },
    {
      name: "all",
      type: "boolean",
      describe: "Print every row.",
    },
    {
      name: "csv",
      type: "boolean",
      describe: "Print the rows as CSV: a header line, then one line per row.",
    },
    {
      name: "json",
      type: "boolean",
      describe: "Print a codegraph.queryResult/1 document: columns, rows (one array per row), total, truncated.",
    },
    {
      name: "views",
      type: "boolean",
      describe:
        "Print the SQL that creates node and dep, for another SQLite client, and exit. Takes no model and no other option.",
    },
  ],
};

/**
 * `codegraph timeline` reads the TEMPORAL store: an entity's life across the
 * revisions `import --at` accumulated. Lifespans are derived by the query,
 * never stored (invariant 4 on the time axis).
 */
export const TIMELINE_SPEC: CommandSpec = {
  name: "timeline",
  summary: "Report an entity's life across the revisions of a temporal store.",
  positional: {
    name: "id",
    describe: "The entity id, rendered form: java:com.acme.order/Basket",
    variadic: false,
    required: true,
  },
  options: [
    {
      name: "store",
      type: "string",
      describe:
        "The temporal model.db (built with `codegraph import --at`); " +
        "defaults to the store beside this directory's default model.",
      placeholder: "FILE",
    },
    JSON_OPTION,
  ],
};

/**
 * `codegraph scm` — the miner. Named `scm`, not `git`, so the door stays open
 * for hg/fossil (PLAN §11.1); the repo positional defaults to `.` because
 * standing in the corpus is the whole workflow, as with the extractor.
 */
export const SCM_SPEC: CommandSpec = {
  name: "scm",
  summary: "Mine a repository's history into a deterministic history.jsonl.",
  positional: {
    name: "repo",
    describe: "Path to the repository to mine.",
    variadic: false,
    required: false,
    defaultPath: () => ".",
  },
  options: [
    {
      name: "since",
      type: "string",
      describe: "Mine only commits newer than this date (passed to git log --since).",
      placeholder: "DATE",
    },
    {
      name: "out",
      type: "string",
      describe: "Write the history here instead of <repo>-history.jsonl.",
      placeholder: "FILE",
    },
    JSON_OPTION,
  ],
};

/**
 * `codegraph snapshots` — the M9b orchestration: sample K revisions, extract
 * each in a throwaway `git worktree` (the main checkout is never mutated), and
 * append every one to the temporal store `import --at` writes. Resumable on
 * purpose: a revision the store already holds is skipped, so an interrupted
 * run — each frame costs a full extraction — continues where it stopped.
 */
export const SNAPSHOTS_SPEC: CommandSpec = {
  name: "snapshots",
  summary: "Extract a repo at sampled revisions into a temporal store (model.db).",
  positional: {
    name: "repo",
    describe: "Path to the repository to snapshot.",
    variadic: false,
    required: false,
    defaultPath: () => ".",
  },
  options: [
    {
      name: "extractor",
      type: "string",
      describe:
        "The extractor run at every revision: a .jar (run with `java -jar`), a .js (run with `node`) " +
        "or an executable such as codegraph-csharp or bin/codegraph-typescript. All honour the extractor " +
        "command-line contract (schemas/README.md §8).",
      placeholder: "FILE",
    },
    {
      name: "jar",
      type: "string",
      describe: "Alias of --extractor kept for the M9b form `--jar codegraph-java.jar`.",
      placeholder: "FILE",
    },
    {
      name: "every",
      type: "string",
      describe:
        "Snapshot every Nth first-parent commit, oldest first; the tip is always included.",
      placeholder: "N",
      integer: true,
    },
    {
      name: "tags",
      type: "boolean",
      describe: "Snapshot the commits the repo's tags point at instead (releases as keyframes).",
    },
    {
      name: "store",
      type: "string",
      describe: "The temporal store to append to; defaults to <repo>-model.db.",
      placeholder: "FILE",
    },
    {
      name: "src",
      type: "string",
      describe: "Directory to extract, relative to the repo root (default: the whole repo).",
      placeholder: "DIR",
    },
    JSON_OPTION,
  ],
};

export const HISTORY_SPEC: CommandSpec = {
  name: "history",
  summary: "Report churn, hotspots and authorship over a mined history.jsonl.",
  positional: {
    name: "history.jsonl",
    describe: "A history.jsonl mined by `codegraph scm`.",
    variadic: false,
    required: false,
    defaultPath: defaultHistoryPath,
    missingHint: "Mine this directory first: codegraph scm .",
  },
  options: [
    {
      name: "report",
      type: "string",
      describe: "Which report to print.",
      choices: HISTORY_REPORTS,
      defaultValue: DEFAULT_HISTORY_REPORT,
    },
    {
      name: "top",
      type: "string",
      describe: "Show only the N highest-ranked rows (hotspots defaults to 20).",
      placeholder: "N",
      integer: true,
    },
    {
      name: "model",
      type: "string",
      describe:
        "A model to join on file paths. hidden and deadweight need one (default: this " +
        "directory's default model). Given to hotspots, each file gains its lines, its " +
        "cyclomatic complexity, its dependency cycle and its rank in four families; given " +
        "to summary, the share of commits that cross a top-level directory of the model.",
      placeholder: "FILE",
    },
    {
      name: "rank",
      type: "string",
      describe:
        "hotspots with --model: the family the rows are ordered by — classic (revisions x " +
        "lines), branchy (revisions x cyclomatic; the default), tangled (revisions of a file " +
        "in a dependency cycle), fragile (revisions x fix density).",
      choices: HOTSPOT_FAMILIES,
    },
    {
      name: "min-support",
      type: "string",
      describe: "Coupling: pairs must co-change in at least N commits.",
      placeholder: "N",
      integer: true,
      defaultValue: "3",
    },
    {
      name: "min-confidence",
      type: "string",
      describe: "Coupling: support over the rarer file's revisions, as a percent.",
      placeholder: "PCT",
      integer: true,
      defaultValue: "50",
    },
    {
      name: "serve",
      type: "boolean",
      describe:
        "Serve the file-level city REPLAY of this history — buildings are files, " +
        "a timeline scrubs the commits (stdout stays empty; Ctrl-C stops it).",
    },
    {
      name: "port",
      type: "string",
      describe: "Port for --serve; 0 picks a free one.",
      placeholder: "N",
      defaultValue: "4177",
    },
    {
      name: "host",
      type: "string",
      describe: "Interface for --serve to bind; 127.0.0.1 keeps the replay on this machine only.",
      placeholder: "ADDR",
      defaultValue: "0.0.0.0",
    },
    {
      name: "city",
      type: "string",
      describe: "Write the laid-out replay city artifact (city.json with a replay block) to FILE.",
      placeholder: "FILE",
    },
    JSON_OPTION,
  ],
};

/**
 * `codegraph replay` — the M9c deliverable: the temporal store becomes ONE
 * laid-out city artifact whose `replay` block scrubs the sampled revisions.
 * Layout runs ONCE on the union of every type that ever existed; plots are
 * frozen, buildings rise at birth and sink at death.
 */
export const REPLAY_SPEC: CommandSpec = {
  name: "replay",
  summary: "Build the entity-level city replay of a temporal store.",
  options: [
    {
      name: "store",
      type: "string",
      describe:
        "The temporal model.db (built by `codegraph snapshots` or `import --at`); " +
        "defaults to the store beside this directory's default model.",
      placeholder: "FILE",
    },
    {
      name: "name",
      type: "string",
      describe: "Corpus display name; defaults to the store's basename.",
      placeholder: "STR",
    },
    {
      name: "history",
      type: "string",
      describe:
        "A history.jsonl (codegraph scm) to join by path suffix: buildings gain " +
        "their file's dominant author, and co-change arcs (logical coupling, " +
        "default thresholds) join the replay.",
      placeholder: "FILE",
    },
    {
      name: "out",
      type: "string",
      describe: "Write the laid-out replay city artifact here instead of stdout.",
      placeholder: "FILE",
    },
    {
      name: "serve",
      type: "boolean",
      describe:
        "Serve the replay in the visualizer — a timeline scrubs the revisions " +
        "(stdout stays empty; Ctrl-C stops it).",
    },
    {
      name: "port",
      type: "string",
      describe: "Port for --serve; 0 picks a free one.",
      placeholder: "N",
      defaultValue: "4177",
    },
    {
      name: "host",
      type: "string",
      describe: "Interface for --serve to bind; 127.0.0.1 keeps the replay on this machine only.",
      placeholder: "ADDR",
      defaultValue: "0.0.0.0",
    },
  ],
};

export const PROFILES_SPEC: CommandSpec = {
  name: "profiles",
  summary: "Print the language profiles core ships.",
  options: [
    {
      name: "lang",
      type: "string",
      describe: "Print only this language's profile (the EntityId prefix, e.g. java).",
      placeholder: "LANG",
    },
    JSON_OPTION,
  ],
};

export const COMMAND_SPECS: readonly CommandSpec[] = [
  VALIDATE_SPEC,
  ANALYZE_SPEC,
  IMPORT_SPEC,
  QUERY_SPEC,
  EXPORT_SPEC,
  CITY_SPEC,
  NAVIGATOR_SPEC,
  VOCABULARY_SPEC,
  SERVE_SPEC,
  DOMAIN_FACTS_SPEC,
  EXPLAIN_SPEC,
  WALK_SPEC,
  INSIGHTS_SPEC,
  SCM_SPEC,
  SNAPSHOTS_SPEC,
  HISTORY_SPEC,
  TIMELINE_SPEC,
  REPLAY_SPEC,
  PROFILES_SPEC,
];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => spec.name === name);
}

/** Options shared by every command that reads models. */
export interface ModelInputOptions {
  /** Positional paths in argument order; loaded as one union. */
  readonly models: readonly string[];
}

/** The two view flags, resolved into a `View` by `resolveView` (view.ts). */
export interface ViewOptions {
  readonly internalOnly: boolean;
  readonly declaredOnly: boolean;
}

/** Shared by every command that can answer from a store instead of a model. */
export interface CacheOptions {
  readonly noCache: boolean;
}

export interface ValidateOptions extends ModelInputOptions {
  readonly json: boolean;
}

export interface AnalyzeOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  readonly report: ReportName;
  readonly level: FoldLevel;
  readonly json: boolean;
  /** `--top N`; undefined means "no limit", the command picks its own default. */
  readonly top: number | undefined;
}

export interface ExportOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  readonly format: FormatName;
  readonly level: FoldLevel;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
}

/** How a city is built — the flags `city` and `serve` share. */
export interface CityBuildOptions extends ViewOptions {
  /** Metric name; validated by the city package, which owns the registry. */
  readonly height: string;
  readonly heightScale: string;
  readonly footprint: string;
  readonly footprintScale: string;
  /** Extra metrics carried on every building; empty when `--carry` was absent. */
  readonly carry: readonly string[];
  /** `--name STR`: corpus display name; undefined derives it from the roots. */
  readonly name: string | undefined;
  /** `--framework NAME`: classify types by that framework; undefined = no roles. */
  readonly framework: string | undefined;
  /** `--history-metrics FILE`; absent = `<model>.history-metrics.jsonl` beside each model, if any. */
  readonly historyMetrics?: string | undefined;
}

export interface CityOptions extends ModelInputOptions, CityBuildOptions {
  /** `--layout`: add placement (positions, bounds) to the artifact. */
  readonly layout: boolean;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
}

export interface NavigatorOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  /** `--name STR`: corpus display name; undefined derives it from the roots. */
  readonly name: string | undefined;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
}

export interface VocabularyOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  readonly level: ScopeLevel;
  /** `--scope ID`: one module, type or operation; undefined = every scope of `level`. */
  readonly scope: string | undefined;
  /** `--top N`; undefined lets each report pick its own default. */
  readonly top: number | undefined;
  readonly termClass: TermClass | "all";
  /** `--weights`: the keys typed, laid over the defaults by the command. */
  readonly weights: Readonly<Partial<Record<WeightKey, number>>>;
  /** `--technical FILE`; undefined = the shared list. */
  readonly technical: string | undefined;
  /** `--drift FILE`: the glossary to compare with. */
  readonly drift: string | undefined;
  /** `--drift-insights`: the classes against the concerns a model judged, from the insights store. */
  readonly driftInsights: boolean;
  /** `--insights FILE`: that store; undefined = beside the first model. */
  readonly insights: string | undefined;
  /** `--out FILE`: the artifact, beside the report. */
  readonly out: string | undefined;
  /** `--svg FILE`: the cloud of the one scope reported, beside the report. */
  readonly svg: string | undefined;
  readonly json: boolean;
}

export interface ServeOptions extends ModelInputOptions, CityBuildOptions, CacheOptions {
  /** `--port N`; 0 = an ephemeral port (the default under `--app`). */
  readonly port: number;
  /** `--host ADDR`; `0.0.0.0` (every interface) by default, `127.0.0.1` under `--app`. */
  readonly host: string;
  /** `--app`: the daemon form; `models` is then empty. */
  readonly app: AppOptions | undefined;
  /** `--insights FILE`: the insights store behind the explanation panel and the glossary; undefined = beside the first model. */
  readonly insights: string | undefined;
}

export interface DomainFactsOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  /** `--framework NAME`: classify by that framework; undefined = no roles. */
  readonly framework: string | undefined;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
}

/** The run flags `explain` and `walk` share (`RUN_OPTIONS`), resolved. */
export interface RunFlags extends ModelInputOptions, ViewOptions, CacheOptions {
  /** `--src DIR`; undefined = the model's `root`. */
  readonly src: string | undefined;
  /** `--out FILE`; undefined = the walk's side-car beside the first model (`<model>.insights.jsonl` for explain). */
  readonly out: string | undefined;
  /** `--provider`; `auto` resolves from the environment (and the Claude Code discovery) at run time. */
  readonly provider: ExplainProvider;
  /** `--claude-path FILE`; undefined = CLAUDE_CODE_PATH, then PATH, then the known install locations. */
  readonly claudePath: string | undefined;
  /** `--model`; undefined = the resolved provider's default (DEFAULT_EXPLAIN_MODEL or DEFAULT_CLAUDE_CODE_MODEL). */
  readonly model: string | undefined;
  /** `--rollup-model`; undefined = the resolved `--model`. */
  readonly rollupModel: string | undefined;
  /** `--depth`, defaulted; `typed.depth` says whether it was typed (a definition's `context` gives way only then). */
  readonly depth: number;
  readonly maxCalls: number | undefined;
  /** `--max-tokens`; undefined = the provider's default (the model's whole output window). */
  readonly maxTokens: number | undefined;
  readonly concurrency: number;
  readonly maxLines: number;
  readonly maxScc: number;
  /** The context flags as TYPED, undefined when absent: they replace a definition's `context` keys. */
  readonly typed: { readonly depth: number | undefined; readonly maxLines: number | undefined };
  readonly framework: string | undefined;
  readonly dryRun: boolean;
  /** `--estimate`: the token-volume report, no call. */
  readonly estimate: boolean;
  /** `--price-in` / `--price-out`, USD per million tokens; undefined = no cost line. */
  readonly priceIn: number | undefined;
  readonly priceOut: number | undefined;
  readonly force: boolean;
  /** `--retry-failed`: the scope is the store's failure records. */
  readonly retryFailed: boolean;
  /** `--export`: write the side-car from the walk's store, and nothing else. */
  readonly exportOnly: boolean;
  /** `--import FILE`: replace the walk's store's content with that side-car, and nothing else. */
  readonly importFrom: string | undefined;
  /** `--yes`: skip the estimate-and-confirm step before a run that makes calls. */
  readonly yes: boolean;
  readonly json: boolean;
}

/** The selection flags (PLAN.md §22.5), parsed: undefined = not given, so a definition's key stands. */
export interface SelectionFlags {
  /** `--include SEL`, each one term (`parseTerm`); several are any of them. */
  readonly include: readonly Selector[];
  readonly exclude: readonly Selector[];
  readonly levels: readonly InsightLevel[] | undefined;
  readonly closure: Closure | undefined;
}

export interface ExplainOptions extends RunFlags, SelectionFlags {
  /** `--terms N`: a module's glossary keeps its heaviest N words. */
  readonly terms: number;
  /** `--scope a,b`; empty = everything. Sugar for `--include id:a --include id:b`. */
  readonly scope: readonly string[];
  /** `--instructions TEXT|@FILE`, as typed; undefined = none (or the `--walk` file's). */
  readonly instructions: string | undefined;
  /** `--walk FILE`: a definition customizing explain. */
  readonly walkFile: string | undefined;
}

export interface WalkOptions extends RunFlags, SelectionFlags {
  /** `--walk FILE`, or `explain` for the built-in; undefined = the default definition. */
  readonly walk: string | undefined;
  /** `--prompt TEXT` / `--prompt-file FILE`: the task at every level. */
  readonly prompt: string | undefined;
  readonly promptFile: string | undefined;
  /** `--instructions TEXT|@FILE`, as typed. */
  readonly instructions: string | undefined;
  /** `--name N`: the definition's name. */
  readonly name: string | undefined;
  /** `--print-definition [explain]`: print that definition and stop; every other field is then a default. */
  readonly printDefinition: "default" | "explain" | undefined;
}

/** What `insights` prints: exactly one of these, decided by the flags. */
export type InsightsMode = "summary" | "list" | "one" | "word" | "glossary" | "polysemy" | "concerns" | "failures" | "runs";

export interface InsightsOptions {
  /** The model path the store sits beside; never opened. */
  readonly model: string;
  /** `--store FILE`; undefined = `<model>.insights.db`, or `--walk N`'s `<model>.N.walk.db`. */
  readonly store: string | undefined;
  /**
   * `--walk N`: whose store it must be — "explain" for explain's. Undefined: explain's beside the model, or with
   * `--store FILE` whichever walk's the file's header names.
   */
  readonly walk: string | undefined;
  readonly mode: InsightsMode;
  readonly id: string | undefined;
  /** `--word WORD`, looked up lowercase. */
  readonly word: string | undefined;
  /** `--glossary MODULE_ID`. */
  readonly glossary: string | undefined;
  readonly level: InsightLevel | undefined;
  readonly concept: string | undefined;
  readonly minConfidence: number | undefined;
  readonly maxConfidence: number | undefined;
  readonly limit: number | undefined;
  readonly json: boolean;
}

export interface ImportOptions extends ModelInputOptions {
  /** `--out FILE`; undefined means `storePathFor` each model. */
  readonly out: string | undefined;
  /** `--at SHA`: append the model as the snapshot at this commit (M9b). */
  readonly at: string | undefined;
  /** `--time T`, parsed to unix seconds; only meaningful with `--at`. */
  readonly time: number | undefined;
  readonly json: boolean;
}

export interface QueryOptions {
  /** `--views`: print the helper views' SQL; nothing is read. */
  readonly views: boolean;
  /** The model.jsonl, or a model.db; undefined only with `--views`. */
  readonly model: string | undefined;
  /** The statement as typed; undefined when `--file` gives it. */
  readonly sql: string | undefined;
  /** `--file FILE`: where the statement is; undefined when it was typed. */
  readonly file: string | undefined;
  /** `--param NAME=VALUE`, by name without the colon; the values as typed. */
  readonly params: Readonly<Record<string, string>>;
  /** `--param-file NAME=FILE`, by name without the colon; the paths as typed. Never a name `params` has. */
  readonly paramFiles: Readonly<Record<string, string>>;
  /** Rows to print; undefined is every row (`--all`). */
  readonly limit: number | undefined;
  readonly format: QueryFormat;
}

export interface TimelineOptions {
  /** The rendered entity id to look up. */
  readonly id: string;
  /** `--store FILE`; undefined means the store beside the default model. */
  readonly store: string | undefined;
  readonly json: boolean;
}

export interface ScmOptions {
  /** The repository to mine; `.` when nothing was typed. */
  readonly repo: string;
  /** `--since DATE`, passed through to `git log --since`. */
  readonly since: string | undefined;
  /** `--out FILE`; undefined means `<repo-basename>-history.jsonl`. */
  readonly out: string | undefined;
  readonly json: boolean;
}

export interface SnapshotsOptions {
  /** The repository to snapshot; `.` when nothing was typed. */
  readonly repo: string;
  /** `--extractor FILE` (or `--jar FILE`): the extractor run at every selected revision. */
  readonly extractor: string;
  /** `--every N`: stride over first-parent commits; exclusive with `tags`. */
  readonly every: number | undefined;
  /** `--tags`: the tagged commits are the keyframes; exclusive with `every`. */
  readonly tags: boolean;
  /** `--store FILE`; undefined means `<repo-basename>-model.db`. */
  readonly store: string | undefined;
  /** `--src DIR`, relative to the repo root; undefined extracts the whole repo. */
  readonly src: string | undefined;
  readonly json: boolean;
}

export interface HistoryOptions {
  /** The history.jsonl to report over. */
  readonly history: string;
  readonly report: HistoryReportName;
  /** `--top N`; undefined lets each report pick its own default. */
  readonly top: number | undefined;
  /** `--model FILE` for the cross-graph reports; undefined means the default model. */
  readonly model: string | undefined;
  /** `--rank FAMILY`: the order of the joined hotspot report; undefined is its default. */
  readonly rank: HotspotFamily | undefined;
  /** Coupling thresholds; the specs' defaults unless overridden. */
  readonly minSupport: number;
  readonly minConfidence: number;
  /** `--serve`: host the visualizer with the file-level replay loaded. */
  readonly serve: boolean;
  readonly port: number;
  readonly host: string;
  /** `--city FILE`: write the laid-out replay artifact. */
  readonly city: string | undefined;
  readonly json: boolean;
}

export interface ReplayOptions {
  /** `--store FILE`; undefined means the store beside the default model. */
  readonly store: string | undefined;
  /** `--name STR`: corpus display name; undefined derives it from the store path. */
  readonly name: string | undefined;
  /** `--history FILE`: join a mined history — owners and co-change arcs. */
  readonly history: string | undefined;
  /** `--out FILE`; undefined means stdout (unless --serve). */
  readonly out: string | undefined;
  readonly serve: boolean;
  readonly port: number;
  readonly host: string;
}

export interface ProfilesOptions {
  readonly lang: string | undefined;
  readonly json: boolean;
}

/**
 * What the argv asked for. `help` and `version` are outcomes in their own right
 * (exit 0, printed on stdout because they are what the user requested), not
 * side effects of parsing.
 */
export type Invocation =
  | { readonly kind: "help"; readonly command: CommandSpec | undefined }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly command: "validate"; readonly options: ValidateOptions }
  | { readonly kind: "run"; readonly command: "analyze"; readonly options: AnalyzeOptions }
  | { readonly kind: "run"; readonly command: "import"; readonly options: ImportOptions }
  | { readonly kind: "run"; readonly command: "query"; readonly options: QueryOptions }
  | { readonly kind: "run"; readonly command: "export"; readonly options: ExportOptions }
  | { readonly kind: "run"; readonly command: "city"; readonly options: CityOptions }
  | { readonly kind: "run"; readonly command: "navigator"; readonly options: NavigatorOptions }
  | { readonly kind: "run"; readonly command: "vocabulary"; readonly options: VocabularyOptions }
  | { readonly kind: "run"; readonly command: "serve"; readonly options: ServeOptions }
  | { readonly kind: "run"; readonly command: "insights"; readonly options: InsightsOptions }
  | { readonly kind: "run"; readonly command: "domain-facts"; readonly options: DomainFactsOptions }
  | { readonly kind: "run"; readonly command: "explain"; readonly options: ExplainOptions }
  | { readonly kind: "run"; readonly command: "walk"; readonly options: WalkOptions }
  | { readonly kind: "run"; readonly command: "scm"; readonly options: ScmOptions }
  | { readonly kind: "run"; readonly command: "snapshots"; readonly options: SnapshotsOptions }
  | { readonly kind: "run"; readonly command: "history"; readonly options: HistoryOptions }
  | { readonly kind: "run"; readonly command: "timeline"; readonly options: TimelineOptions }
  | { readonly kind: "run"; readonly command: "replay"; readonly options: ReplayOptions }
  | { readonly kind: "run"; readonly command: "profiles"; readonly options: ProfilesOptions };

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V"]);

function commandList(): string {
  return COMMAND_NAMES.join(", ");
}

/** `--report <deps|cycles|coupling>`, `--out FILE`, `--json` — one flag, rendered. */
export function flagSyntax(option: OptionSpec): string {
  const flag = `--${option.name}`;
  if (option.type === "boolean") return flag;
  if (option.choices !== undefined) return `${flag} <${option.choices.join("|")}>`;
  return `${flag} ${option.placeholder ?? "VALUE"}`;
}

/** The one-line usage string, generated so it cannot contradict the spec. */
export function usageLine(spec: CommandSpec): string {
  const parts = [`codegraph ${spec.name}`];
  if (spec.positional !== undefined) {
    const name = spec.positional.variadic ? `${spec.positional.name}...` : spec.positional.name;
    parts.push(spec.positional.required ? `<${name}>` : `[${name}]`);
    if (spec.positional.second !== undefined) parts.push(`[${spec.positional.second.name}]`);
  }
  for (const option of spec.options) {
    parts.push(option.required === true ? flagSyntax(option) : `[${flagSyntax(option)}]`);
  }
  return parts.join(" ");
}

/** The options a command accepts, as one line — used by every usage error. */
export function optionSummary(spec: CommandSpec): string {
  const flags = spec.options.map(flagSyntax);
  flags.push("--help");
  return `Valid options for 'codegraph ${spec.name}': ${flags.join(", ")}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function optionLines(spec: CommandSpec): readonly string[] {
  const rendered = spec.options.map((option) => {
    const left = option.short === undefined
      ? `  ${flagSyntax(option)}`
      : `  -${option.short}, ${flagSyntax(option)}`;
    const notes: string[] = [];
    if (option.required === true) notes.push("required");
    if (option.defaultValue !== undefined) notes.push(`default: ${option.defaultValue}`);
    const right = notes.length === 0 ? option.describe : `${option.describe} (${notes.join("; ")})`;
    return [left, right] as const;
  });
  rendered.push(["  -h, --help", "Show this help."] as const);
  const width = Math.max(...rendered.map(([left]) => left.length)) + 2;
  return rendered.map(([left, right]) => `${pad(left, width)}${right}`);
}

/** Help for one command, or the global help when `spec` is undefined. */
export function renderHelp(spec: CommandSpec | undefined): string {
  const lines: string[] = [];
  if (spec === undefined) {
    lines.push("codegraph — dependency analysis over codegraph model.jsonl files.");
    lines.push("");
    lines.push("usage: codegraph <command> [options]");
    lines.push("");
    lines.push("commands:");
    const width = Math.max(...COMMAND_SPECS.map((s) => s.name.length)) + 4;
    for (const s of COMMAND_SPECS) lines.push(`  ${pad(s.name, width)}${s.summary}`);
    lines.push("");
    lines.push("global options:");
    lines.push("  -h, --help      Show this help.");
    lines.push("  -v, --version   Print the codegraph version.");
    lines.push("");
    lines.push("Run `codegraph <command> --help` for a command's own options.");
  } else {
    lines.push(`codegraph ${spec.name} — ${spec.summary}`);
    lines.push("");
    lines.push(`usage: ${usageLine(spec)}`);
    if (spec.positional !== undefined) {
      lines.push("");
      lines.push("arguments:");
      const name = spec.positional.variadic ? `<${spec.positional.name}...>` : `<${spec.positional.name}>`;
      const fallback = spec.positional.defaultPath;
      const describe =
        fallback === undefined
          ? spec.positional.describe
          : spec.positional.missingHint === undefined && spec.positional.name === "model.jsonl"
            ? `${spec.positional.describe} (default: ${fallback()}, what the extractor writes here)`
            : `${spec.positional.describe} (default: ${fallback()})`;
      lines.push(`  ${name}   ${describe}`);
      const second = spec.positional.second;
      if (second !== undefined) lines.push(`  [${second.name}]   ${second.describe}`);
    }
    lines.push("");
    lines.push("options:");
    lines.push(...optionLines(spec));
  }
  lines.push("");
  lines.push("exit codes: 0 ok · 1 internal error (a bug) · 2 usage error · 3 findings.");
  return lines.join("\n");
}

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

function parseArgsConfig(spec: CommandSpec): {
  readonly [flag: string]: { readonly type: "boolean" | "string"; readonly short?: string; readonly multiple?: boolean };
} {
  const config: Record<string, { type: "boolean" | "string"; short?: string; multiple?: boolean }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const option of spec.options) {
    config[option.name] = {
      type: option.type,
      ...(option.short === undefined ? {} : { short: option.short }),
      ...(option.multiple === true ? { multiple: true } : {}),
    };
  }
  return config;
}

function stringOf(values: ParsedValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function flagOf(values: ParsedValues, name: string): boolean {
  return values[name] === true;
}

/** A repeatable flag's values, in the order typed; empty when absent. */
function stringsOf(values: ParsedValues, name: string): readonly string[] {
  const value = values[name];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Spec-driven validation: required-ness, closed value sets and integer values
 * are checked from the SAME data the help text is rendered from. Returns the
 * validated string values by flag name; booleans are read with `flagOf`.
 */
function validateValues(spec: CommandSpec, values: ParsedValues): void {
  for (const option of spec.options) {
    if (option.type === "boolean" || option.multiple === true) continue;
    const value = stringOf(values, option.name);
    if (value === undefined) {
      if (option.required === true) {
        throw new UsageError(
          `${spec.name} requires ${flagSyntax(option)}`,
          `${usageLine(spec)}\n${option.describe}`,
        );
      }
      continue;
    }
    if (option.choices !== undefined && !option.choices.includes(value)) {
      throw new UsageError(
        `invalid value '${value}' for --${option.name}`,
        `Valid values: ${option.choices.join(", ")}.`,
      );
    }
    if (option.integer === true) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError(
          `invalid value '${value}' for --${option.name}`,
          `Expected a whole number >= 1.`,
        );
      }
    }
  }
}

function integerOf(values: ParsedValues, name: string): number | undefined {
  const value = stringOf(values, name);
  return value === undefined ? undefined : Number(value);
}

/** `--price-in 0.10`: a non-negative USD amount per million tokens. */
function priceOf(values: ParsedValues, name: string): number | undefined {
  const raw = stringOf(values, name);
  if (raw === undefined) return undefined;
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0) {
    throw new UsageError(`--${name} must be a non-negative USD amount per million tokens, got '${raw}'`, "Example: --price-in 0.10 --price-out 0.60");
  }
  return price;
}

function confidenceOf(values: ParsedValues, name: string): number | undefined {
  const raw = stringOf(values, name);
  if (raw === undefined) return undefined;
  const confidence = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new UsageError(`--${name} must be a number between 0 and 1, got '${raw}'`, "A record's confidence is the model's own, clamped to [0, 1]. Example: --max-confidence 0.5");
  }
  return confidence;
}

function levelOf(values: ParsedValues): FoldLevel {
  const value = stringOf(values, "level");
  return value === undefined ? DEFAULT_LEVEL : (value as FoldLevel);
}

/**
 * `--port N`: a TCP port; 0 is allowed on purpose (the OS picks a free one).
 * The fallback comes from the SPEC's own default, so the value the help text
 * promises and the value the parser uses cannot drift apart.
 */
function portOf(values: ParsedValues, spec: CommandSpec): number {
  const raw =
    stringOf(values, "port") ?? spec.options.find((option) => option.name === "port")?.defaultValue;
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(
      `--port must be an integer between 0 and 65535, got '${raw}'`,
      "0 asks the OS for a free port; the chosen port is printed on stderr.",
    );
  }
  return port;
}

/**
 * `--host ADDR`: the interface to bind. Not a closed set — any address this
 * machine holds is legitimate, and only the OS knows which — so the value is
 * carried through and a bad one surfaces as the bind failure that names it
 * (serve.ts). Blank is rejected here, because `--host ""` silently means
 * "every interface" to `listen`, which is the opposite of what typing an
 * empty address suggests.
 */
function hostOf(values: ParsedValues, spec: CommandSpec): string {
  const raw =
    stringOf(values, "host") ?? spec.options.find((option) => option.name === "host")?.defaultValue;
  const host = (raw ?? "").trim();
  if (host.length === 0) {
    throw new UsageError(
      "--host needs an address",
      "0.0.0.0 binds every interface; 127.0.0.1 binds this machine only.",
    );
  }
  return host;
}

/** The daemon's default bind address — this machine only. */
const LOOPBACK = "127.0.0.1";

/**
 * `--app [--data-dir DIR] [--extractors FILE]`. The two value flags mean
 * nothing without `--app`, and `--app` takes no model: both are usage errors
 * rather than silently ignored flags.
 */
function appOf(values: ParsedValues, spec: CommandSpec, positionals: readonly string[]): AppOptions | undefined {
  const dataDir = stringOf(values, "data-dir");
  const extractors = stringOf(values, "extractors");
  if (!flagOf(values, "app")) {
    const stray = dataDir !== undefined ? "--data-dir" : extractors !== undefined ? "--extractors" : undefined;
    if (stray !== undefined) {
      throw new UsageError(`${stray} only means something with --app`, usageLine(spec));
    }
    return undefined;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `--app takes no model (got '${positionals[0] ?? ""}'): the app opens folders through its routes`,
      "Drop the path, or drop --app to serve a model.",
    );
  }
  return { dataDir: resolve(dataDir ?? defaultDataDir()), extractors };
}

/** The city's build flags, resolved once for `city` and `serve` alike. */
function cityBuildOf(values: ParsedValues): CityBuildOptions {
  return {
    height: stringOf(values, "height") ?? "loc",
    heightScale: stringOf(values, "height-scale") ?? "linear",
    footprint: stringOf(values, "footprint") ?? "members",
    footprintScale: stringOf(values, "footprint-scale") ?? "sqrt",
    carry: metricList(stringOf(values, "carry")),
    name: stringOf(values, "name"),
    framework: stringOf(values, "framework"),
    historyMetrics: stringOf(values, "history-metrics"),
    ...viewOf(values),
  };
}

function metricList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function viewOf(values: ParsedValues): ViewOptions {
  return {
    internalOnly: flagOf(values, "internal-only"),
    declaredOnly: flagOf(values, "declared-only"),
  };
}

/**
 * A path nobody typed must explain itself: parsing checks the default is there,
 * so its absence names the file AND how to produce it, instead of surfacing as
 * an ENOENT on a file name the user never wrote. Typed paths are NOT checked
 * here — loading owns those, and reports them per file.
 */
function readableDefault(spec: CommandSpec, path: string): string {
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    const make =
      spec.positional?.missingHint ??
      "Extract this directory first: java -jar codegraph-java.jar, or codegraph-csharp for a C# tree";
    throw new UsageError(
      `no ${spec.positional?.name ?? "path"} given, and the default '${path}' is not here`,
      `${make}\nor pass a path: ${usageLine(spec)}`,
      { cause: error },
    );
  }
  return path;
}

function positionalsOf(spec: CommandSpec, positionals: readonly string[]): readonly string[] {
  if (spec.positional === undefined) {
    if (positionals.length > 0) {
      throw new UsageError(
        `${spec.name} takes no positional arguments (got '${positionals[0] ?? ""}')`,
        `${usageLine(spec)}\n${optionSummary(spec)}`,
      );
    }
    return [];
  }
  if (positionals.length === 0) {
    const fallback = spec.positional.defaultPath;
    if (fallback !== undefined) return [readableDefault(spec, fallback())];
    if (spec.positional.required) {
      throw new UsageError(
        `${spec.name} needs at least one ${spec.positional.name} path`,
        `${usageLine(spec)}\n${spec.positional.describe}`,
      );
    }
  }
  const second = spec.positional.second;
  if (second !== undefined && positionals.length > 2) {
    // Almost always a statement the shell split into words.
    throw new UsageError(
      `${spec.name} takes a ${spec.positional.name} and one ${second.name}, but ${positionals.length} arguments were given`,
      `Quote the ${second.name} so the shell passes it as one argument.\n${usageLine(spec)}`,
    );
  }
  if (!spec.positional.variadic && second === undefined && positionals.length > 1) {
    throw new UsageError(
      `${spec.name} takes a single ${spec.positional.name}`,
      usageLine(spec),
    );
  }
  return positionals;
}

/**
 * `parseArgs` states the problem well ("Unknown option '--repot'") and then
 * appends advice about `--` that is noise for a flag typo. Keep the first
 * sentence, drop the lecture, and let the hint name what IS valid.
 */
function usageFromParseArgs(spec: CommandSpec, error: unknown): UsageError {
  const raw = error instanceof Error ? error.message : String(error);
  const cut = raw.indexOf(". To specify");
  const trimmed = cut === -1 ? raw : raw.slice(0, cut);
  const message = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return new UsageError(`${message} for 'codegraph ${spec.name}'`, optionSummary(spec), { cause: error });
}

/**
 * Parse an argv tail (`process.argv.slice(2)`) into an {@link Invocation}.
 * Throws {@link UsageError} — never writes, never exits: `main` owns both.
 */
export function parseInvocation(argv: readonly string[]): Invocation {
  const first = argv[0];
  if (first === undefined) {
    throw new UsageError("no command given", `Commands: ${commandList()}. Try 'codegraph --help'.`);
  }
  if (HELP_FLAGS.has(first)) return { kind: "help", command: undefined };
  if (VERSION_FLAGS.has(first)) return { kind: "version" };
  if (first.startsWith("-")) {
    throw new UsageError(
      `unknown global option '${first}'`,
      `Global options: --help, --version. Commands: ${commandList()}.`,
    );
  }

  const spec = commandSpec(first);
  if (spec === undefined) {
    throw new UsageError(`unknown command '${first}'`, `Valid commands: ${commandList()}.`);
  }

  const rest = argv.slice(1);
  // `--help` wins over every other check: asking for help must work even when
  // the rest of the line is wrong — that is usually WHY it is being asked for.
  if (rest.some((token) => HELP_FLAGS.has(token))) return { kind: "help", command: spec };

  let parsed: { values: ParsedValues; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...rest],
      options: parseArgsConfig(spec),
      // Always allowed at the parser level so `positionalsOf` can say WHY a
      // stray argument is wrong, in the command's own words.
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usageFromParseArgs(spec, error);
  }

  validateValues(spec, parsed.values);
  const values = parsed.values;
  // `serve --app` opens folders through its routes, so no model is defaulted
  // from the working directory — the one command whose positional is optional.
  const isApp = spec.name === "serve" && flagOf(values, "app");
  // `walk --print-definition [explain]` and `query --views` read no model: a positional, if any, is not one.
  const printing = spec.name === "walk" && flagOf(values, "print-definition");
  const isViews = spec.name === "query" && flagOf(values, "views");
  const models = isApp || printing || isViews ? parsed.positionals : positionalsOf(spec, parsed.positionals);

  switch (spec.name) {
    case "validate":
      return { kind: "run", command: "validate", options: { models, json: flagOf(values, "json") } };
    case "analyze":
      return {
        kind: "run",
        command: "analyze",
        options: {
          models,
          report: (stringOf(values, "report") ?? DEFAULT_REPORT) as ReportName,
          level: levelOf(values),
          ...viewOf(values),
          noCache: flagOf(values, "no-cache"),
          json: flagOf(values, "json"),
          top: integerOf(values, "top"),
        },
      };
    case "import": {
      const out = stringOf(values, "out");
      // `--out` names ONE file, so it cannot mean anything for several models.
      // Silently importing only the first, or writing them all to one path,
      // are both worse than saying so.
      if (out !== undefined && models.length > 1) {
        throw new UsageError(
          `--out takes one model, but ${models.length} were given`,
          "Import them one at a time, or drop --out to write each store beside its model.",
        );
      }
      const at = stringOf(values, "at");
      // A snapshot is ONE model at ONE commit — several models cannot share a sha.
      if (at !== undefined && models.length > 1) {
        throw new UsageError(
          `--at takes one model, but ${models.length} were given`,
          "A snapshot is one model at one commit; import each revision separately.",
        );
      }
      const rawTime = stringOf(values, "time");
      if (rawTime !== undefined && at === undefined) {
        throw new UsageError(
          "--time only means something with --at",
          "It is the commit time of the snapshot --at names.",
        );
      }
      return {
        kind: "run",
        command: "import",
        options: { models, out, at, time: timeOf(rawTime), json: flagOf(values, "json") },
      };
    }
    case "export":
      return {
        kind: "run",
        command: "export",
        options: {
          models,
          format: stringOf(values, "format") as FormatName,
          level: levelOf(values),
          ...viewOf(values),
          noCache: flagOf(values, "no-cache"),
          out: stringOf(values, "out"),
        },
      };
    case "city":
      return {
        kind: "run",
        command: "city",
        options: {
          models,
          ...cityBuildOf(values),
          layout: flagOf(values, "layout"),
          out: stringOf(values, "out"),
        },
      };
    case "navigator":
      return {
        kind: "run",
        command: "navigator",
        options: {
          models,
          name: stringOf(values, "name"),
          ...viewOf(values),
          noCache: flagOf(values, "no-cache"),
          out: stringOf(values, "out"),
        },
      };
    case "vocabulary":
      return { kind: "run", command: "vocabulary", options: { models, ...vocabularyOf(values) } };
    case "serve": {
      const app = appOf(values, spec, models);
      return {
        kind: "run",
        command: "serve",
        options: {
          models: app === undefined ? models : [],
          ...cityBuildOf(values),
          // The daemon is loopback-only on an ephemeral port unless told otherwise:
          // its URL is a capability the shell reads, not an address to announce.
          port: app !== undefined && stringOf(values, "port") === undefined ? 0 : portOf(values, spec),
          host: app !== undefined && stringOf(values, "host") === undefined ? LOOPBACK : hostOf(values, spec),
          noCache: flagOf(values, "no-cache"),
          app,
          insights: stringOf(values, "insights"),
        },
      };
    }
    case "domain-facts":
      return {
        kind: "run",
        command: "domain-facts",
        options: {
          models,
          framework: stringOf(values, "framework"),
          ...viewOf(values),
          noCache: flagOf(values, "no-cache"),
          out: stringOf(values, "out"),
        },
      };
    case "explain": {
      checkSrc(values, models);
      if (flagOf(values, "retry-failed") && stringOf(values, "scope") !== undefined) {
        throw new UsageError(
          "--retry-failed and --scope both choose what to explain",
          "--retry-failed takes its scope from the side-car's failure records; drop --scope, or drop --retry-failed to explain a scope afresh.",
        );
      }
      checkRetrySelection(values, "explain");
      return {
        kind: "run",
        command: "explain",
        options: {
          ...runFlagsOf(values, models),
          ...selectionOf(values),
          terms: integerOf(values, "terms") ?? DEFAULT_TERMS,
          scope: metricList(stringOf(values, "scope")),
          instructions: stringOf(values, "instructions"),
          walkFile: stringOf(values, "walk"),
        },
      };
    }
    case "walk": {
      if (printing) return { kind: "run", command: "walk", options: printDefinitionOf(values, models) };
      checkSrc(values, models);
      checkRetrySelection(values, "ask");
      return { kind: "run", command: "walk", options: walkOptionsOf(values, models) };
    }
    case "insights": {
      const id = stringOf(values, "id");
      const word = stringOf(values, "word");
      const glossary = stringOf(values, "glossary");
      const filters = ["level", "concept", "min-confidence", "max-confidence", "limit"].filter((name) => stringOf(values, name) !== undefined);
      // One question per invocation: each shape prints a different thing.
      const questions: readonly (readonly [InsightsMode, string | undefined])[] = [
        ["one", id === undefined ? undefined : "--id"],
        ["word", word === undefined ? undefined : "--word"],
        ["glossary", glossary === undefined ? undefined : "--glossary"],
        ["polysemy", flagOf(values, "polysemy") ? "--polysemy" : undefined],
        ["concerns", flagOf(values, "concerns") ? "--concerns" : undefined],
        ["failures", flagOf(values, "failures") ? "--failures" : undefined],
        ["runs", flagOf(values, "runs") ? "--runs" : undefined],
        ["list", filters[0] === undefined ? undefined : `--${filters[0]}`],
      ];
      const asked = questions.filter(([, flag]) => flag !== undefined);
      if (asked.length > 1) {
        throw new UsageError(
          `${asked.map(([, flag]) => flag).join(" and ")} ask different questions`,
          "Pass one of: --id ID (one explanation), a list filter (--level, --concept, --min/--max-confidence), --word WORD, " +
            "--glossary MODULE_ID, --polysemy, --concerns, --failures, --runs — or none, for the summary.",
        );
      }
      if (word?.trim() === "") throw new UsageError("--word needs a word", "A word as 'codegraph vocabulary' lists it, e.g. --word order.");
      const walk = stringOf(values, "walk");
      // Checked here: the name becomes part of a path (`<model>.N.walk.db`), so `../` never reaches one.
      if (walk !== undefined && walk !== EXPLAIN_WALK_NAME && (!WALK_NAME_PATTERN.test(walk) || walk === "insights")) {
        throw new UsageError(
          `--walk ${JSON.stringify(walk)} is not a walk name: one matches [a-z][a-z0-9-]*, and "insights" is reserved for explain's store`,
          "The name a walk was run under (--name N, or its definition's name); 'explain' reads explain's store.",
        );
      }
      const mode: InsightsMode = asked[0]?.[0] ?? "summary";
      return {
        kind: "run",
        command: "insights",
        options: {
          model: models[0] as string,
          store: stringOf(values, "store"),
          walk,
          mode,
          id,
          word,
          glossary,
          level: stringOf(values, "level") as InsightLevel | undefined,
          concept: stringOf(values, "concept"),
          minConfidence: confidenceOf(values, "min-confidence"),
          maxConfidence: confidenceOf(values, "max-confidence"),
          limit: integerOf(values, "limit"),
          json: flagOf(values, "json"),
        },
      };
    }
    case "scm":
      return {
        kind: "run",
        command: "scm",
        options: {
          repo: models[0] as string,
          since: stringOf(values, "since"),
          out: stringOf(values, "out"),
          json: flagOf(values, "json"),
        },
      };
    case "snapshots": {
      const every = integerOf(values, "every");
      const tags = flagOf(values, "tags");
      // Exactly one selector: the keyframes are either a stride or the tags —
      // ambiguity here would silently choose which revisions cost extractions.
      if ((every !== undefined) === tags) {
        throw new UsageError(
          every === undefined
            ? "snapshots needs a revision selector"
            : "--every and --tags are two different revision selectors",
          "Pick exactly one: --every N (stride over first-parent commits) or --tags.",
        );
      }
      const extractor = stringOf(values, "extractor") ?? stringOf(values, "jar");
      if (extractor === undefined) {
        throw new UsageError(
          "snapshots needs an extractor",
          "Pass --extractor FILE: extractors/java/target/codegraph-java.jar, or a codegraph-csharp binary.",
        );
      }
      return {
        kind: "run",
        command: "snapshots",
        options: {
          repo: models[0] as string,
          extractor,
          every,
          tags,
          store: stringOf(values, "store"),
          src: stringOf(values, "src"),
          json: flagOf(values, "json"),
        },
      };
    }
    case "history": {
      const report = (stringOf(values, "report") ?? DEFAULT_HISTORY_REPORT) as HistoryReportName;
      const rank = stringOf(values, "rank") as HotspotFamily | undefined;
      if (rank !== undefined && report !== "hotspots") {
        throw new UsageError(
          `--rank orders the joined hotspot report, not ${report}`,
          "Use it with --report hotspots --model FILE.",
        );
      }
      if (rank !== undefined && stringOf(values, "model") === undefined) {
        throw new UsageError(
          "--rank needs a model to rank by",
          "Name it: --report hotspots --model FILE --rank " + rank,
        );
      }
      return {
        kind: "run",
        command: "history",
        options: {
          history: models[0] as string,
          report,
          top: integerOf(values, "top"),
          model: stringOf(values, "model"),
          rank,
          minSupport: integerOf(values, "min-support") ?? 3,
          minConfidence: (integerOf(values, "min-confidence") ?? 50) / 100,
          serve: flagOf(values, "serve"),
          port: portOf(values, spec),
          host: hostOf(values, spec),
          city: stringOf(values, "city"),
          json: flagOf(values, "json"),
        },
      };
    }
    case "query":
      return { kind: "run", command: "query", options: queryOf(values, spec, models) };
    case "timeline":
      return {
        kind: "run",
        command: "timeline",
        options: {
          id: models[0] as string,
          store: stringOf(values, "store"),
          json: flagOf(values, "json"),
        },
      };
    case "replay":
      return {
        kind: "run",
        command: "replay",
        options: {
          store: stringOf(values, "store"),
          name: stringOf(values, "name"),
          history: stringOf(values, "history"),
          out: stringOf(values, "out"),
          serve: flagOf(values, "serve"),
          port: portOf(values, spec),
          host: hostOf(values, spec),
        },
      };
    case "profiles":
      return {
        kind: "run",
        command: "profiles",
        options: { lang: stringOf(values, "lang"), json: flagOf(values, "json") },
      };
  }
}

/** `--src` names ONE source root, so it cannot go with several models. */
function checkSrc(values: ParsedValues, models: readonly string[]): void {
  if (stringOf(values, "src") !== undefined && models.length > 1) {
    throw new UsageError(
      "--src applies to one model: its anchors are relative to ONE source root",
      "Run explain once per model, or drop --src to read each model's own root.",
    );
  }
}

const SELECTION_FLAGS = ["include", "exclude", "levels", "closure"] as const;

/** `--retry-failed` takes its selection from the store's failure records: a selection flag would be a second answer. */
function checkRetrySelection(values: ParsedValues, verb: string): void {
  if (!flagOf(values, "retry-failed")) return;
  const flag = SELECTION_FLAGS.find((name) => values[name] !== undefined);
  if (flag === undefined) return;
  throw new UsageError(
    `--retry-failed and --${flag} both choose what to ${verb}`,
    `--retry-failed takes its selection from the store's failure records; drop --${flag}, or drop --retry-failed to ${verb} a selection afresh.`,
  );
}

/** The run flags `explain` and `walk` share (`RUN_OPTIONS`), with the checks that span two of them. */
function runFlagsOf(values: ParsedValues, models: readonly string[]): RunFlags {
  if (flagOf(values, "export") && stringOf(values, "import") !== undefined) {
    throw new UsageError(
      "--export and --import move the same records in opposite directions",
      "Run them one after the other: --import FILE replaces the store, --export writes the side-car from it.",
    );
  }
  const provider = (stringOf(values, "provider") ?? "auto") as ExplainProvider;
  const claudePath = stringOf(values, "claude-path");
  // A named binary is meant to run (auto implies claude-code); a key provider could only ignore it.
  if (claudePath !== undefined && provider !== "auto" && provider !== "claude-code") {
    throw new UsageError(
      `--claude-path names a binary that --provider ${provider} would never run`,
      "Drop --claude-path, or pass --provider claude-code (or auto, which it implies).",
    );
  }
  const depth = integerOf(values, "depth");
  const maxLines = integerOf(values, "max-lines");
  return {
    models,
    src: stringOf(values, "src"),
    out: stringOf(values, "out"),
    provider,
    claudePath,
    model: stringOf(values, "model"),
    rollupModel: stringOf(values, "rollup-model"),
    depth: depth ?? 1,
    maxCalls: integerOf(values, "max-calls"),
    maxTokens: integerOf(values, "max-tokens"),
    concurrency: integerOf(values, "concurrency") ?? 4,
    maxLines: maxLines ?? 200,
    maxScc: integerOf(values, "max-scc") ?? 12,
    typed: { depth, maxLines },
    framework: stringOf(values, "framework"),
    ...viewOf(values),
    noCache: flagOf(values, "no-cache"),
    dryRun: flagOf(values, "dry-run"),
    estimate: flagOf(values, "estimate"),
    priceIn: priceOf(values, "price-in"),
    priceOut: priceOf(values, "price-out"),
    force: flagOf(values, "force"),
    retryFailed: flagOf(values, "retry-failed"),
    exportOnly: flagOf(values, "export"),
    importFrom: stringOf(values, "import"),
    yes: flagOf(values, "yes"),
    json: flagOf(values, "json"),
  };
}

const TERM_HINT =
  "One selector term per flag, PREFIX:VALUE: id:ID, kind:K, trait:T, lang:L, name:GLOB, module:GLOB, file:GLOB, " +
  "edge:KIND or edge:KIND>TERM, edge-in:KIND or edge-in:KIND<TERM. Repeat the flag for several (any of them).";

/** One selector term, parsed now: a typo in a kind is a usage error before any model is read. */
function termOf(flag: string, text: string): Selector {
  try {
    return parseTerm(text);
  } catch (error) {
    if (!(error instanceof SelectorError)) throw error;
    throw new UsageError(`--${flag} ${error.message}`, TERM_HINT, { cause: error });
  }
}

/** `--levels a,b`: a set of the walk's levels, in walk order; empty, unknown or repeated is a usage error. */
function levelsOf(raw: string | undefined): readonly InsightLevel[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  const valid = `Valid levels: ${INSIGHT_LEVELS.join(", ")}, comma-separated.`;
  if (names.length === 0) throw new UsageError("--levels needs at least one level", valid);
  const seen = new Set<string>();
  for (const name of names) {
    if (!(INSIGHT_LEVELS as readonly string[]).includes(name)) throw new UsageError(`--levels: unknown level "${name}"`, valid);
    if (seen.has(name)) throw new UsageError(`--levels: "${name}" is listed twice`, valid);
    seen.add(name);
  }
  return INSIGHT_LEVELS.filter((level) => seen.has(level));
}

function selectionOf(values: ParsedValues): SelectionFlags {
  return {
    include: stringsOf(values, "include").map((text) => termOf("include", text)),
    exclude: stringsOf(values, "exclude").map((text) => termOf("exclude", text)),
    levels: levelsOf(stringOf(values, "levels")),
    closure: stringOf(values, "closure") as Closure | undefined,
  };
}

/** `walk`'s own flags over the run and selection flags; `--walk explain` takes neither a task nor a name. */
function walkOptionsOf(values: ParsedValues, models: readonly string[]): WalkOptions {
  const walk = stringOf(values, "walk");
  const prompt = stringOf(values, "prompt");
  const promptFile = stringOf(values, "prompt-file");
  const name = stringOf(values, "name");
  if (prompt !== undefined && promptFile !== undefined) {
    throw new UsageError("--prompt and --prompt-file both give the task", "Pass one of them: the task is one text, asked at every level.");
  }
  if (walk === "explain") {
    const stray = prompt !== undefined ? "--prompt" : promptFile !== undefined ? "--prompt-file" : name !== undefined ? "--name" : undefined;
    if (stray !== undefined) {
      throw new UsageError(
        `${stray} does not apply to --walk explain`,
        "explain asks its own task under its own name (its store is <model>.insights.db): --instructions and the selection flags customize it. A task of your own is a walk of your own: --prompt TEXT or --walk FILE.",
      );
    }
  }
  return {
    ...runFlagsOf(values, models),
    ...selectionOf(values),
    walk,
    prompt,
    promptFile,
    instructions: stringOf(values, "instructions"),
    name,
    printDefinition: undefined,
  };
}

/** `--print-definition [explain]`: nothing else is read, so nothing else may be typed. */
function printDefinitionOf(values: ParsedValues, positionals: readonly string[]): WalkOptions {
  const other = Object.keys(values).find((flag) => flag !== "print-definition" && values[flag] !== undefined);
  if (other !== undefined) {
    throw new UsageError(
      `--print-definition takes no other option (got --${other})`,
      "codegraph walk --print-definition [explain] > walk.json prints a file to start from; edit it, then run it with --walk walk.json.",
    );
  }
  const [which, ...rest] = positionals;
  if (rest.length > 0 || (which !== undefined && which !== "explain")) {
    throw new UsageError(
      `--print-definition prints the default definition, or explain's: got '${positionals.join(" ")}'`,
      "codegraph walk --print-definition prints the default; codegraph walk --print-definition explain, explain's.",
    );
  }
  return { ...walkOptionsOf({}, []), printDefinition: which === "explain" ? "explain" : "default" };
}

/** A parameter's name as SQLite reads it after the colon. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * `--param NAME=VALUE` and `--param-file NAME=FILE`, each split at the FIRST
 * `=`: a value, like a path, may hold others. A value may be empty; a file may
 * not. One name is bound once, whichever of the two flags gives it.
 */
function paramsOf(values: ParsedValues): { params: Readonly<Record<string, string>>; paramFiles: Readonly<Record<string, string>> } {
  const params: Record<string, string> = {};
  const paramFiles: Record<string, string> = {};
  const read = (option: "param" | "param-file", into: Record<string, string>): void => {
    const shape = option === "param" ? "NAME=VALUE" : "NAME=FILE";
    for (const raw of stringsOf(values, option)) {
      const cut = raw.indexOf("=");
      const name = (cut === -1 ? raw : raw.slice(0, cut)).replace(/^:/, "");
      const value = raw.slice(cut + 1);
      if (cut === -1 || !PARAM_NAME.test(name) || (option === "param-file" && value === "")) {
        throw new UsageError(
          `--${option} needs ${shape}, got '${raw}'`,
          option === "param"
            ? "NAME is the parameter as the statement writes it after the colon: --param id='java:com.acme/Order' binds :id."
            : "NAME is the parameter as the statement writes it after the colon: --param-file rows=saved.json binds :rows to that file's text.",
        );
      }
      if (Object.hasOwn(params, name) || Object.hasOwn(paramFiles, name)) {
        throw new UsageError(`parameter ${name} is given twice`, "One value per parameter: --param or --param-file, once.");
      }
      into[name] = value;
    }
  };
  read("param", params);
  read("param-file", paramFiles);
  return { params, paramFiles };
}

/**
 * `query`'s shapes: `--views` alone, or a model with ONE source for the
 * statement. Each contradiction is refused by name rather than resolved by a
 * precedence nobody would guess.
 */
function queryOf(values: ParsedValues, spec: CommandSpec, positionals: readonly string[]): QueryOptions {
  const file = stringOf(values, "file");
  const { params, paramFiles } = paramsOf(values);
  const json = flagOf(values, "json");
  const csv = flagOf(values, "csv");
  const all = flagOf(values, "all");
  const limit = integerOf(values, "limit");

  if (flagOf(values, "views")) {
    const stray =
      positionals[0] ??
      (file !== undefined ? "--file" : undefined) ??
      (Object.keys(params).length > 0 ? "--param" : undefined) ??
      (Object.keys(paramFiles).length > 0 ? "--param-file" : undefined) ??
      (json ? "--json" : csv ? "--csv" : all ? "--all" : limit !== undefined ? "--limit" : undefined);
    if (stray !== undefined) {
      throw new UsageError(
        `--views prints the two views and reads nothing: it takes no model and no other option (got '${stray}')`,
        "Run 'codegraph query --views' alone; the views are already there in every 'codegraph query <model.jsonl> …'.",
      );
    }
    return { views: true, model: undefined, sql: undefined, file: undefined, params: {}, paramFiles: {}, limit: undefined, format: "table" };
  }

  const [model, sql] = positionals;
  if (sql === undefined && file === undefined) {
    throw new UsageError(
      "query needs a statement",
      `Quote it after the model, or pass --file FILE.\n${usageLine(spec)}`,
    );
  }
  if (sql !== undefined && file !== undefined) {
    throw new UsageError(
      "query takes ONE statement: the one on the command line, or the one in --file",
      "Drop one of the two.",
    );
  }
  if (json && csv) {
    throw new UsageError("--json and --csv are two forms of the same rows", "Pass one of them, or neither for the table.");
  }
  if (all && limit !== undefined) {
    throw new UsageError("--all and --limit contradict each other", "--all prints every row; --limit N prints at most N.");
  }
  return {
    views: false,
    model,
    sql,
    file,
    params,
    paramFiles,
    limit: all ? undefined : (limit ?? DEFAULT_QUERY_LIMIT),
    format: json ? "json" : csv ? "csv" : "table",
  };
}

function vocabularyOf(values: ParsedValues): Omit<VocabularyOptions, "models"> {
  const scope = stringOf(values, "scope");
  const drift = stringOf(values, "drift");
  // A flag the chosen report would not read is refused, never silently dropped.
  const unread: readonly (readonly [boolean, string, string])[] = [
    [scope !== undefined && stringOf(values, "level") !== undefined, "--level", "--scope"],
    [scope !== undefined && drift !== undefined, "--drift", "--scope"],
    [drift !== undefined && stringOf(values, "class") !== undefined, "--class", "--drift"],
  ];
  for (const [conflict, flag, report] of unread) {
    if (!conflict) continue;
    throw new UsageError(
      `${flag} does not apply with ${report}`,
      report === "--scope"
        ? "--scope reports one scope; drop --level and --drift, or drop --scope."
        : "--drift compares the business terms with every word, and lists the domain words no term contains.",
    );
  }
  const svg = stringOf(values, "svg");
  const level = stringOf(values, "level");
  const driftInsights = flagOf(values, "drift-insights");
  const insights = stringOf(values, "insights");
  if (insights !== undefined && !driftInsights) {
    throw new UsageError("--insights does not apply without --drift-insights", "--insights names the store --drift-insights reads.");
  }
  if (driftInsights) {
    const read = [
      [scope !== undefined, "--scope"],
      [level !== undefined, "--level"],
      [stringOf(values, "class") !== undefined, "--class"],
      [svg !== undefined, "--svg"],
    ] as const;
    for (const [given, flag] of read) {
      if (!given) continue;
      throw new UsageError(
        `${flag} does not apply with --drift-insights`,
        "--drift-insights compares every word a model judged, over the corpus, with the class the list gives it.",
      );
    }
  }
  const many = drift !== undefined ? "--drift" : level !== undefined && level !== "corpus" ? `--level ${level}` : undefined;
  if (svg !== undefined && many !== undefined) {
    throw new UsageError(`--svg does not apply with ${many}`, "--svg draws one scope's cloud: the corpus, or the one --scope names.");
  }
  return {
    level: (stringOf(values, "level") ?? "corpus") as ScopeLevel,
    scope,
    top: integerOf(values, "top"),
    termClass: (stringOf(values, "class") ?? "domain") as TermClass | "all",
    weights: weightsOf(stringOf(values, "weights")),
    technical: stringOf(values, "technical"),
    drift,
    driftInsights,
    insights,
    out: stringOf(values, "out"),
    svg,
    json: flagOf(values, "json"),
    ...viewOf(values),
    noCache: flagOf(values, "no-cache"),
  };
}

/** `--weights type=6,qualifier=0`: a known key, once, weighing a number >= 0. */
function weightsOf(raw: string | undefined): Partial<Record<WeightKey, number>> {
  if (raw === undefined) return {};
  const weights: Partial<Record<WeightKey, number>> = {};
  for (const entry of raw.split(",")) {
    const [key = "", value, ...rest] = entry.split("=").map((part) => part.trim());
    const weight = Number(value);
    if (value === undefined || value === "" || rest.length > 0 || key === "" || !Number.isFinite(weight) || weight < 0) {
      throw new UsageError(
        `invalid entry '${entry.trim()}' in --weights`,
        "Each entry is KEY=N, N a number >= 0: --weights type=6,qualifier=0",
      );
    }
    if (!(WEIGHT_KEYS as readonly string[]).includes(key)) {
      throw new UsageError(`unknown role '${key}' in --weights`, `Valid keys: ${WEIGHT_KEYS.join(", ")}.`);
    }
    const role = key as WeightKey;
    if (weights[role] !== undefined) throw new UsageError(`--weights weighs ${role} twice`, "Name each key once.");
    weights[role] = weight;
  }
  return weights;
}

/** `--time`: unix seconds, or anything `Date.parse` reads (ISO dates). */
function timeOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new UsageError(
      `invalid value '${raw}' for --time`,
      "Pass unix seconds (1704103200) or an ISO date (2024-01-01T10:00:00Z).",
    );
  }
  return Math.floor(parsed / 1000);
}
