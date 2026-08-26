import { Buffer } from "node:buffer";
import { buildNavigator, navigatorToJsonString, type NavigatorModel } from "@codegraph/navigator";
import type { NavigatorOptions } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { openAnalysis, type AnalysisSource } from "../source.js";
import { navigatorAssetsDir, startArtifactServer, type ArtifactServerOptions } from "../serve.js";
import { resolveView } from "../view.js";

/**
 * `codegraph navigator <model.jsonl...> [--serve]`.
 *
 * Writes the NAVIGATOR MODEL — the browsable tree plus one classified
 * dependency row per base edge — as JSON on stdout, or to `--out FILE`, or
 * hands it to the localhost frontend as /navigator.json. The transform lives
 * in `@codegraph/navigator`; this command only resolves flags, loads models
 * and moves bytes (decision 7).
 *
 * Unlike `city` this goes through `openAnalysis`, so a single model gets the
 * sibling model.db cache for free (with the standard one-line `cache:` note on
 * stderr) — the navigator needs the FULL base graph, which the source
 * hydrates from the store when one answers.
 *
 * STREAM PURITY (decision 3): with no `--out`, stdout carries the artifact and
 * nothing else. Warnings, the cache note and the `--out` confirmation are
 * stderr. `--serve` keeps stdout empty — the server is the destination.
 *
 * `--serve` binds every interface by default (`--host`), unlike `city`, so the
 * navigator is reachable from another machine without extra ceremony. The
 * server announces that reach on stderr; the artifact it hands out is the
 * whole model, so the address is worth reading.
 */

/** The server seam, injectable so tests need no sockets and no built frontend. */
export interface NavigatorServeDeps {
  readonly assetsDir: typeof navigatorAssetsDir;
  readonly startServer: (serverOptions: ArtifactServerOptions) => unknown;
}
const REAL_SERVE: NavigatorServeDeps = {
  assetsDir: navigatorAssetsDir,
  startServer: startArtifactServer,
};

export function navigatorCommand(
  options: NavigatorOptions,
  io: IoSink,
  deps: NavigatorServeDeps = REAL_SERVE,
): ExitCode {
  // Resolve the assets FIRST: an unbuilt frontend must fail before a large
  // model is loaded, not after.
  const assets = options.serve ? deps.assetsDir() : undefined;

  const source = openAnalysis(options.models, options, io);
  try {
    const model = buildNavigator(source.graph(), {
      view: resolveView(options),
      ...(options.name === undefined ? {} : { name: options.name }),
    });
    const artifact = navigatorToJsonString(model);

    errLines(io, warnings(source, model));

    if (options.out !== undefined) {
      io.writeFile(options.out, artifact);
      errLine(
        io,
        `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out} ` +
          `(${describe(model)}).`,
      );
    } else if (assets === undefined) {
      io.out(artifact);
    }

    if (assets !== undefined) {
      deps.startServer({
        artifact,
        artifactRoute: "/navigator.json",
        label: "model navigator",
        assets,
        port: options.port,
        host: options.host,
        io,
      });
    }

    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    source.close();
  }
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}

/** What the artifact is, for the human stream only. */
function describe(model: NavigatorModel): string {
  return (
    `navigator, view ${model.view.name}, ${plural(model.nodes.length, "node")}, ` +
    `${plural(model.deps.length, "dependency row")}`
  );
}

/**
 * Everything that makes the navigator smaller or vaguer than the model, on
 * stderr — a tree that quietly omits entities is how a wrong impression of a
 * codebase gets believed.
 */
function warnings(source: AnalysisSource, model: NavigatorModel): readonly string[] {
  const lines: string[] = [];
  if (!source.clean) {
    lines.push(
      `warning: the models are not clean; the navigator was built anyway.`,
      `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`,
    );
  }
  if (model.diagnostics.droppedDeps > 0) {
    lines.push(
      `warning: ${plural(model.diagnostics.droppedDeps, "dependency edge")} dropped — ` +
        `an endpoint has no owning node in this view.`,
    );
  }
  return lines;
}
