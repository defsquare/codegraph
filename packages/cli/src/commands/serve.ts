import { buildNavigator, navigatorToJsonString } from "@codegraph/navigator";
import { cityToJsonString, layoutCity } from "@codegraph/city";
import type { ServeOptions } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { errLines, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { navigatorAssetsDir, startArtifactServer, type ArtifactServerOptions } from "../serve.js";
import { resolveView } from "../view.js";
import { cityOf, cityWarnings } from "./city.js";
import { navigatorWarnings } from "./navigator.js";

/**
 * `codegraph serve <model.jsonl...> [--port N] [--host ADDR] [city metrics…]`.
 *
 * ONE PAGE OVER A MODEL: the navigator (tree, fan-in/fan-out evidence, graph,
 * cycles, coupling) with the 3D city as one of its tabs. Both artifacts are
 * built here, from the SAME graph under the SAME view, so a building clicked
 * in the city names exactly the entity the tree reveals — the two artifacts
 * share the entity ids, and the page joins them on nothing else.
 *
 * The CLI stays inside its box (decision 7): the transforms live in
 * `@codegraph/navigator` and `@codegraph/city`, the frontend is the prebuilt
 * `@codegraph/navigator-ui` bundle (which embeds `@codegraph/viz`), and this
 * command only resolves flags, loads models and hands the server two JSON
 * routes — `/navigator.json` and `/city.json`, each exactly the file the
 * respective command's `--out` would have written.
 *
 * Stdout stays empty: the server is the destination. Warnings and the reach
 * announcement are stderr. The command returns at once; the live server is
 * what keeps the process running, until Ctrl-C.
 */

/** The server seam, injectable so tests need no sockets and no built frontend. */
export interface ServeDeps {
  readonly assetsDir: typeof navigatorAssetsDir;
  readonly startServer: (serverOptions: ArtifactServerOptions) => unknown;
}
const REAL_SERVE: ServeDeps = { assetsDir: navigatorAssetsDir, startServer: startArtifactServer };

export const NAVIGATOR_ROUTE = "/navigator.json";
export const CITY_ROUTE = "/city.json";

export function serveCommand(options: ServeOptions, io: IoSink, deps: ServeDeps = REAL_SERVE): ExitCode {
  // Resolve the assets FIRST: an unbuilt frontend must fail before a large
  // model is loaded, not after.
  const assets = deps.assetsDir();

  const source = openAnalysis(options.models, options, io);
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const navigator = buildNavigator(graph, {
      view,
      ...(options.name === undefined ? {} : { name: options.name }),
    });
    // The viewer refuses a city with no placement, so the layout is not optional.
    const city = layoutCity(cityOf(graph, options));

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
    ]);

    deps.startServer({
      routes: {
        [NAVIGATOR_ROUTE]: navigatorToJsonString(navigator),
        [CITY_ROUTE]: cityToJsonString(city),
      },
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
