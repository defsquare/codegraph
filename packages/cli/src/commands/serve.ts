import { readFileSync, statSync } from "node:fs";
import { buildNavigator, navigatorToJsonString } from "@codegraph/navigator";
import { cityToJsonString, layoutCity } from "@codegraph/city";
import { buildVocabulary, vocabularyCarriers, vocabularyToJsonString } from "@codegraph/vocabulary";
import type { AppOptions, ServeOptions } from "../args.js";
import { startDaemon, type DaemonOptions } from "../app/daemon.js";
import { createJobRunner } from "../app/jobs.js";
import { parseRegistry, type Registry } from "../app/registry.js";
import { CARRIERS_ROUTE, carriersLookup } from "../carriers-route.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { loadHistoryJoin } from "../history-metrics.js";
import { GLOSSARY_ROUTE, glossaryLookup, modelPlacement } from "../glossary-route.js";
import { INSIGHT_ROUTE, insightLookup, storeReader } from "../insight-route.js";
import { storePathForModel } from "../insights-paths.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { navigatorAssets, startArtifactServer, type ArtifactServerOptions, type FrontendAssets } from "../serve.js";
import { resolveView } from "../view.js";
import { cityOf, cityWarnings } from "./city.js";
import { navigatorWarnings } from "./navigator.js";
import { vocabularyWarnings } from "./vocabulary.js";

/**
 * `codegraph serve <model.jsonl...> [--port N] [--host ADDR] [city metrics…]`.
 *
 * ONE PAGE OVER A MODEL: the navigator (tree, fan-in/fan-out evidence, graph,
 * cycles, coupling, vocabulary) with the 3D city as one of its tabs. The three
 * artifacts are built here, from the SAME graph under the SAME view, so a
 * building clicked in the city names exactly the entity the tree reveals, and
 * a type's words are found by the id of its tree node — the artifacts share
 * the entity ids, and the page joins them on nothing else.
 *
 * The CLI stays inside its box (decision 7): the transforms live in
 * `@codegraph/navigator`, `@codegraph/city` and `@codegraph/vocabulary`, the
 * frontend is the prebuilt `@codegraph/navigator-ui` bundle (which embeds
 * `@codegraph/viz`), and this command only resolves flags, loads models and
 * hands the server three JSON routes — `/navigator.json`, `/city.json` and
 * `/vocabulary.json`, each exactly the file the respective command's `--out`
 * would have written (the vocabulary under its default weights and list).
 *
 * THREE ROUTES ARE NOT ARTIFACTS: `/insight.json?id=…`, a selected node's
 * explanation, looked up in `<model>.insights.db` when asked for (M16c) — no
 * store means a 404 the page ignores, so a model nobody explained looks
 * exactly as it did; `/carriers.json?term=…`, the names that carry a word
 * of the vocabulary, answered from the model this command holds (M19b); and
 * `/glossary.json?term=…`, what the explained entities under a scope said
 * that word means — the same store, placed by the same model (M19c).
 *
 * Stdout stays empty: the server is the destination. Warnings and the reach
 * announcement are stderr. The command returns at once; the live server is
 * what keeps the process running, until Ctrl-C.
 *
 * `--app` IS THE DAEMON (PLAN §15.2): no model on argv; the same page, served
 * under a per-launch capability token on loopback, with routes that open a
 * folder (detect the extractor, run it, build both artifacts) and stream the
 * progress. Stdout then carries exactly one line — `{"port","token"}` — and
 * the process ends when stdin does. See `app/daemon.ts` and `app/jobs.ts`.
 */

/** The server seam, injectable so tests need no sockets and no built frontend. */
export interface ServeDeps {
  readonly assetsDir: typeof navigatorAssets;
  readonly startServer: (serverOptions: ArtifactServerOptions) => unknown;
  readonly startDaemon: (daemonOptions: DaemonOptions) => unknown;
  /** The daemon's lifetime: the process stdin by default; tests hand it a stream of their own. */
  readonly stdin: NodeJS.ReadableStream | undefined;
}
const REAL_SERVE: ServeDeps = {
  assetsDir: navigatorAssets,
  startServer: startArtifactServer,
  startDaemon,
  stdin: process.stdin,
};

export const NAVIGATOR_ROUTE = "/navigator.json";
export const CITY_ROUTE = "/city.json";
export const VOCABULARY_ROUTE = "/vocabulary.json";

export function serveCommand(options: ServeOptions, io: IoSink, deps: ServeDeps = REAL_SERVE): ExitCode {
  // Resolve the assets FIRST: an unbuilt frontend must fail before a large
  // model is loaded, not after.
  const assets = deps.assetsDir();

  if (options.app !== undefined) return appCommand(options, options.app, assets, io, deps);

  const source = openAnalysis(options.models, options, io);
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const navigator = buildNavigator(graph, {
      view,
      ...(options.name === undefined ? {} : { name: options.name }),
    });
    const counting = { view, ...(options.name === undefined ? {} : { name: options.name }) };
    const vocabulary = buildVocabulary(graph, counting);
    // The viewer refuses a city with no placement, so the layout is not optional.
    const history = loadHistoryJoin(options.historyMetrics, options.models);
    const city = layoutCity(cityOf(graph, options, history, vocabulary));

    // One "not clean" line for the page, then each artifact's own caveats.
    const built = { clean: true, paths: source.paths };
    errLines(io, [
      ...(source.clean
        ? []
        : [
            `warning: the models are not clean; the page was built anyway.`,
            `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`,
          ]),
      ...navigatorWarnings(built, navigator),
      ...cityWarnings(built, city),
      ...vocabularyWarnings(built, vocabulary),
    ]);

    // Beside the FIRST model, like explain's default; --insights names it otherwise. Opened on first request.
    const store = storeReader(options.insights ?? storePathForModel(options.models[0] ?? ""));
    const insights = insightLookup(store);
    // Each holds the graph until its first answerable request builds what it needs, then lets it go.
    const carriers = carriersLookup(() => vocabularyCarriers(graph, vocabulary, counting));
    const glossary = glossaryLookup(store, () => modelPlacement(graph, view));
    deps.startServer({
      routes: {
        [NAVIGATOR_ROUTE]: navigatorToJsonString(navigator),
        [CITY_ROUTE]: cityToJsonString(city),
        [VOCABULARY_ROUTE]: vocabularyToJsonString(vocabulary),
      },
      lookups: { [INSIGHT_ROUTE]: insights.handle, [CARRIERS_ROUTE]: carriers.handle, [GLOSSARY_ROUTE]: glossary.handle },
      onClose: () => store.close(),
      label: "codegraph",
      assets,
      port: options.port,
      host: options.host,
      io,
    });

    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    source.close();
  }
}

/** The registry file, or an empty registry when none was named. */
export function registryOf(app: AppOptions): Registry {
  if (app.extractors === undefined) return [];
  let text: string;
  try {
    text = readFileSync(app.extractors, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read the extractor registry ${app.extractors}: ${error instanceof Error ? error.message : String(error)}`,
      "It is a JSON list of { name, path, extensions[] } entries the shell writes before launching the daemon.",
      { cause: error },
    );
  }
  return parseRegistry(text, app.extractors);
}

/**
 * The registry as a source that follows its file: the shell rewrites it after
 * a rescan (window focus, a menu action), and the next job sees the result —
 * the page's "Check again" is a plain retry. Read once up front so a bad file
 * is a usage error before any port is taken; a later rewrite that does not
 * parse keeps the last good registry and says so on stderr rather than
 * killing a daemon the window is already using.
 */
export function registrySource(app: AppOptions, io: IoSink): () => Registry {
  let current = registryOf(app);
  let seen = mtimeOf(app.extractors);
  return () => {
    const now = mtimeOf(app.extractors);
    if (now === seen) return current;
    seen = now;
    try {
      current = registryOf(app);
      errLine(io, `registry: reloaded ${app.extractors ?? ""} (${current.length} entries)`);
    } catch (error) {
      errLine(io, `registry: ${error instanceof Error ? error.message : String(error)} — keeping the previous entries`);
    }
    return current;
  };
}

function mtimeOf(path: string | undefined): number {
  if (path === undefined) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * The daemon: registry validated up front (a bad file is a usage error before
 * a port is taken), one job runner over `--data-dir`, the server under its
 * token. The exit code is the command's — the process lives on with the server.
 */
function appCommand(options: ServeOptions, app: AppOptions, assets: FrontendAssets, io: IoSink, deps: ServeDeps): ExitCode {
  const registry = registrySource(app, io);
  const runner = createJobRunner({ dataDir: app.dataDir, registry, build: options, io });
  deps.startDaemon({
    assets,
    port: options.port,
    host: options.host,
    io,
    runner,
    registry,
    dataDir: app.dataDir,
    lifetime: { stdin: deps.stdin, signals: true },
  });
  return EXIT.OK;
}
