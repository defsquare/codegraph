import { accessSync, constants } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FOLD_LEVELS, FRAMEWORK_PROFILES, type FoldLevel } from "@codegraph/analyzer";
import { METRIC_PREFIXES, SCALES, metricNames } from "@codegraph/city";
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
  "export",
  "city",
  "navigator",
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
 * they join the mined history with a model, so they read `--model` too.
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
    `Open forms: ${METRIC_PREFIXES.map((form) => `${form.prefix}<key>`).join(", ")}.`
  );
}

export const CITY_SPEC: CommandSpec = {
  name: "city",
  summary: "Write the code city: modules as districts, types as buildings.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
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
      name: "name",
      type: "string",
      describe:
        "Display name for the corpus in the visualizer header; " +
        "defaults to the basename of each model's root.",
      placeholder: "STR",
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
    {
      name: "layout",
      type: "boolean",
      describe:
        "Lay the city out: positions on buildings, bounds on districts, by recursive shelf packing.",
    },
    {
      name: "serve",
      type: "boolean",
      describe:
        "Serve the 3D visualizer with this city loaded (implies --layout; " +
        "stdout stays empty; Ctrl-C stops it). Needs the built viz app (pnpm -r build).",
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
      describe: "Interface for --serve to bind; 127.0.0.1 keeps the city on this machine only.",
      placeholder: "ADDR",
      defaultValue: "0.0.0.0",
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
  summary: "Explore the model: a searchable tree with per-node dependency detail.",
  positional: MODELS_POSITIONAL_DEFAULTED,
  options: [
    {
      name: "name",
      type: "string",
      describe:
        "Display name for the corpus in the navigator header; " +
        "defaults to the basename of each model's root.",
      placeholder: "STR",
    },
    {
      name: "serve",
      type: "boolean",
      describe:
        "Serve the navigator with this model loaded, on every interface unless --host says " +
        "otherwise (stdout stays empty; Ctrl-C stops it). Needs the built navigator-ui app " +
        "(pnpm -r build).",
    },
    {
      name: "port",
      type: "string",
      describe: "Port for --serve; 0 picks a free one.",
      placeholder: "N",
      defaultValue: "4178",
    },
    {
      name: "host",
      type: "string",
      describe:
        "Address --serve binds. 0.0.0.0 is every interface, so the page is reachable " +
        "from other machines; 127.0.0.1 keeps it to this one.",
      placeholder: "ADDR",
      defaultValue: "0.0.0.0",
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
      name: "jar",
      type: "string",
      describe: "The codegraph-java extractor jar, run with `java -jar` at every revision.",
      placeholder: "FILE",
      required: true,
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
        "Model for the cross-graph reports (hidden, deadweight); " +
        "defaults to this directory's default model.",
      placeholder: "FILE",
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
  EXPORT_SPEC,
  CITY_SPEC,
  NAVIGATOR_SPEC,
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

export interface CityOptions extends ModelInputOptions, ViewOptions {
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
  /** `--layout`: add placement (positions, bounds) to the artifact. */
  readonly layout: boolean;
  /** `--serve`: host the visualizer with this city loaded. */
  readonly serve: boolean;
  /** `--port N` for `--serve`; 0 = an ephemeral port. */
  readonly port: number;
  /** `--host ADDR` for `--serve`; all interfaces unless the user narrows it. */
  readonly host: string;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
}

export interface NavigatorOptions extends ModelInputOptions, ViewOptions, CacheOptions {
  /** `--name STR`: corpus display name; undefined derives it from the roots. */
  readonly name: string | undefined;
  /** `--serve`: host the navigator on localhost with this model loaded. */
  readonly serve: boolean;
  /** `--port N` for `--serve`; 0 = an ephemeral port. */
  readonly port: number;
  /** `--host ADDR` for `--serve`; `0.0.0.0` (every interface) by default. */
  readonly host: string;
  /** `--out FILE`; undefined means stdout. */
  readonly out: string | undefined;
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
  /** `--jar FILE`: the extractor jar run at every selected revision. */
  readonly jar: string;
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
  | { readonly kind: "run"; readonly command: "export"; readonly options: ExportOptions }
  | { readonly kind: "run"; readonly command: "city"; readonly options: CityOptions }
  | { readonly kind: "run"; readonly command: "navigator"; readonly options: NavigatorOptions }
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
          : spec.positional.missingHint === undefined
            ? `${spec.positional.describe} (default: ${fallback()}, what the extractor writes here)`
            : `${spec.positional.describe} (default: ${fallback()})`;
      lines.push(`  ${name}   ${describe}`);
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
  readonly [flag: string]: { readonly type: "boolean" | "string"; readonly short?: string };
} {
  const config: Record<string, { type: "boolean" | "string"; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const option of spec.options) {
    config[option.name] =
      option.short === undefined ? { type: option.type } : { type: option.type, short: option.short };
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

/**
 * Spec-driven validation: required-ness, closed value sets and integer values
 * are checked from the SAME data the help text is rendered from. Returns the
 * validated string values by flag name; booleans are read with `flagOf`.
 */
function validateValues(spec: CommandSpec, values: ParsedValues): void {
  for (const option of spec.options) {
    if (option.type === "boolean") continue;
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

/** `--carry a,b` → ["a","b"]; blanks dropped so `a,,b` is not a metric named "". */
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
    const make = spec.positional?.missingHint ?? "Extract this directory first: java -jar codegraph-java.jar";
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
  if (!spec.positional.variadic && positionals.length > 1) {
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
  const models = positionalsOf(spec, parsed.positionals);
  const values = parsed.values;

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
          height: stringOf(values, "height") ?? "loc",
          heightScale: stringOf(values, "height-scale") ?? "linear",
          footprint: stringOf(values, "footprint") ?? "members",
          footprintScale: stringOf(values, "footprint-scale") ?? "sqrt",
          carry: metricList(stringOf(values, "carry")),
          name: stringOf(values, "name"),
          framework: stringOf(values, "framework"),
          layout: flagOf(values, "layout"),
          serve: flagOf(values, "serve"),
          port: portOf(values, spec),
          host: hostOf(values, spec),
          ...viewOf(values),
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
          serve: flagOf(values, "serve"),
          port: portOf(values, spec),
          host: hostOf(values, spec),
          ...viewOf(values),
          noCache: flagOf(values, "no-cache"),
          out: stringOf(values, "out"),
        },
      };
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
      return {
        kind: "run",
        command: "snapshots",
        options: {
          repo: models[0] as string,
          jar: stringOf(values, "jar") as string,
          every,
          tags,
          store: stringOf(values, "store"),
          src: stringOf(values, "src"),
          json: flagOf(values, "json"),
        },
      };
    }
    case "history":
      return {
        kind: "run",
        command: "history",
        options: {
          history: models[0] as string,
          report: (stringOf(values, "report") ?? DEFAULT_HISTORY_REPORT) as HistoryReportName,
          top: integerOf(values, "top"),
          model: stringOf(values, "model"),
          minSupport: integerOf(values, "min-support") ?? 3,
          minConfidence: (integerOf(values, "min-confidence") ?? 50) / 100,
          serve: flagOf(values, "serve"),
          port: portOf(values, spec),
          host: hostOf(values, spec),
          city: stringOf(values, "city"),
          json: flagOf(values, "json"),
        },
      };
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
