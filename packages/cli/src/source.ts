import {
  buildGraph,
  diagnoseStore,
  foldFromStore,
  foldGraph,
  hydrateModel,
  importGraph,
  importGraphFromStore,
  isClean,
  loadDecodedModels,
  openCache,
  typeDependencyGraph,
  type CodeGraph,
  type FoldOptions,
  type FoldedGraph,
  type ImportGraph,
  type LoadDiagnostics,
  type View,
} from "@codegraph/analyzer";
import { errLine, type IoSink } from "./io.js";
import { loadModelFiles, type LoadedModels } from "./load.js";

/**
 * WHERE AN ANALYSIS COMES FROM.
 *
 * `analyze` and `export` ask the same three questions — is the model clean,
 * fold it, and (for `deps`) give me the import layer — and until now they asked
 * them of a `Model` read out of a `.jsonl`. A store can answer all three
 * without reading the model at all, so this is the seam that decides which.
 *
 * THE COMMANDS DO NOT KNOW. Neither `analyze` nor `export` branches on it; they
 * ask an `AnalysisSource` and get the same answer either way. That is what
 * makes byte-identity checkable rather than hoped for: there is no second
 * formatting path to keep in step, only a second way of computing the same
 * `FoldedGraph`, which `store-fold.test.ts` pins as an equality.
 *
 * THE CACHE IS USED ONLY WHEN IT CAN BE EXACT:
 *
 *  - one model, because a store holds one model and surrogates are file-scoped
 *    (MM-1) — a union would mean renumbering, and a renumbered corpus is a
 *    repointed one;
 *  - `--no-cache` absent;
 *  - a store that can be built or reused; a read-only directory is not a
 *    failure, it is a reason to read the `.jsonl`;
 *  - a view SQL can translate. `foldFromStore` returns `undefined` for anything
 *    else and this HYDRATES from the store rather than guessing — still no
 *    JSONL parse, just a slower answer.
 *
 * Every one of those falls back to the path that was there before, so the worst
 * case is the old speed, never a different number.
 */
export interface AnalysisSource {
  /** The input paths as typed — the labels every diagnostic keys on. */
  readonly paths: readonly string[];
  readonly diagnostics: LoadDiagnostics;
  readonly clean: boolean;
  /** For the stderr note; the user must be able to tell what answered. */
  readonly note: string;

  fold(options: FoldOptions): FoldedGraph;
  /** The module→module import layer, with its endpoint audit. */
  imports(view: View): ImportGraph;
  /** Every edge kind folded to type level. */
  typeDependencies(view: View): FoldedGraph;
  /** The base graph, materialized only if something needs it. */
  graph(): CodeGraph;
  close(): void;
}

export interface SourceOptions {
  /** `--no-cache`: never touch a store, even one that is already there. */
  readonly noCache: boolean;
}

/**
 * Open the models for analysis, through the cache when that is exact.
 *
 * Throws {@link UsageError} for an unreadable path, exactly as
 * `loadModelFiles` does — the cache changes how a model is READ, never what
 * counts as a usable invocation.
 */
export function openAnalysis(
  paths: readonly string[],
  options: SourceOptions,
  io: IoSink,
): AnalysisSource {
  const attempt =
    options.noCache || paths.length !== 1
      ? {
          store: undefined,
          reason: options.noCache
            ? "disabled by --no-cache"
            : `${paths.length} models load as one union, which no single store holds`,
        }
      : openCache(paths[0]!);

  if (attempt.store === undefined) {
    errLine(io, `cache: not used — ${attempt.reason}. Reading the model.`);
    // Including a model the reader refuses: `loadModelFiles` turns that into a
    // schema-error diagnostic with the reader's own message and exit 3, which
    // is a diagnosis rather than a crash.
    return fromModels(loadModelFiles(paths));
  }

  const store = attempt.store;
  // ONE LINE, whether this run built the store or reused one. Two consecutive
  // runs of the same command must produce identical stderr — `e2e-determinism`
  // says so, and its reason is that an elapsed-time figure turns every CI log
  // into a false diff. Whether THIS invocation paid for the import is a
  // performance detail; `codegraph import` is the command that reports it.
  errLine(io, `cache: ${store.path}`);
  return fromStore(store.db, paths[0]!, store.path);
}

/** The path that existed before the store: read every model and union them. */
function fromModels(loaded: LoadedModels): AnalysisSource {
  let graph: CodeGraph | undefined;
  const built = (): CodeGraph => (graph ??= buildGraph(loaded.union));
  return {
    paths: loaded.paths,
    diagnostics: loaded.diagnostics,
    clean: loaded.clean,
    note: "model",
    fold: (options) => foldGraph(built(), options),
    imports: (view) => importGraph(built(), view),
    typeDependencies: (view) => typeDependencyGraph(built(), view),
    graph: built,
    close: () => {
      /* nothing to release */
    },
  };
}

/**
 * The store path. Folds are answered in SQL when the view translates; the graph
 * is hydrated only if something asks for it, and then through core's own
 * `ModelBuilder`, so it is the same object the file would have produced.
 */
function fromStore(db: CachedDb, label: string, storePath: string): AnalysisSource {
  const diagnostics = diagnoseStore(db, { label, modelIndex: 0 });
  let graph: CodeGraph | undefined;
  const built = (): CodeGraph => {
    if (graph === undefined) {
      graph = buildGraph(loadDecodedModels([hydrateModel(db)], { sources: [label] }).union);
    }
    return graph;
  };

  return {
    paths: [label],
    diagnostics,
    clean: isClean(diagnostics),
    note: storePath,
    fold: (options) => foldFromStore(db, options) ?? foldGraph(built(), options),
    imports: (view) => importGraphFromStore(db, view) ?? importGraph(built(), view),
    typeDependencies: (view) =>
      foldFromStore(db, { level: "type", view }) ?? typeDependencyGraph(built(), view),
    graph: built,
    close: () => {
      db.close();
    },
  };
}

type CachedDb = NonNullable<ReturnType<typeof openCache>["store"]>["db"];
