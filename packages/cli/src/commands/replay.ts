import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { listRevisions, openStore, readEntityHistory, storePathFor } from "@codegraph/analyzer";
import { buildEntityCity, cityToJsonString, layoutReplayCity } from "@codegraph/city";
import { defaultModelPath, type ReplayOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, type IoSink } from "../io.js";
import { startCityServer, vizAssetsDir, type CityServerOptions } from "../serve.js";

/**
 * `codegraph replay [--store FILE] [--out FILE] [--serve]` (M9c, PLAN §11.3).
 *
 * The temporal store becomes ONE laid-out city artifact: every type that EVER
 * existed gets a frozen plot (layout runs once, on the union), and the
 * `replay` block carries one tick per sampled revision — buildings rise at
 * birth, sink at death, and land is vacant before its time. The transform
 * lives in `@codegraph/city` (`buildEntityCity`); the analyzer supplies the
 * time axis (`readEntityHistory`); this command only moves bytes between them.
 *
 * ALWAYS LAID OUT: unlike the static `city` artifact, a replay exists to be
 * scrubbed, and the viewer refuses a city with no placement — an un-laid-out
 * replay artifact has no consumer.
 *
 * STREAM PURITY (decision 3): with no `--out` and no `--serve`, stdout carries
 * the artifact and nothing else; the summary and warnings go to stderr.
 */

/** The server seam, injectable so tests need no sockets and no built viz. */
export interface ServeDeps {
  readonly assetsDir: typeof vizAssetsDir;
  readonly startServer: (serverOptions: CityServerOptions) => unknown;
}
const REAL_SERVE: ServeDeps = { assetsDir: vizAssetsDir, startServer: startCityServer };

export function replayCommand(
  options: ReplayOptions,
  io: IoSink,
  deps: ServeDeps = REAL_SERVE,
): ExitCode {
  // Resolve the assets FIRST: an unbuilt visualizer must fail before the
  // store is read, not after.
  const assets = options.serve ? deps.assetsDir() : undefined;
  const storePath = options.store ?? storePathFor(defaultModelPath());

  let db: ReturnType<typeof openStore>;
  try {
    db = openStore(storePath);
  } catch (error) {
    throw new UsageError(
      `cannot open the store at ${storePath}`,
      "Build a temporal store first: codegraph snapshots <repo> --jar <extractor.jar> --tags " +
        `--store ${storePath}`,
      { cause: error },
    );
  }

  let history: ReturnType<typeof readEntityHistory>;
  try {
    if (listRevisions(db).length === 0) {
      throw new UsageError(
        `${storePath} holds no revisions — it is a plain single-model cache`,
        "Append snapshots with: codegraph snapshots <repo> --jar <extractor.jar> --tags " +
          `--store ${storePath}`,
      );
    }
    history = readEntityHistory(db);
  } finally {
    db.close();
  }

  const name = options.name ?? basename(storePath).replace(/\.db$/, "");
  const city = buildEntityCity(history, { name });
  const artifact = cityToJsonString(layoutReplayCity(city));

  errLine(
    io,
    `replay city of ${storePath}: ${plural(city.districts.length, "district")}, ` +
      `${plural(city.buildings.length, "building")}, ` +
      `${plural(city.replay.ticks.length, "revision")} on the timeline.`,
  );
  const unmeasured = city.bindings.find((binding) => binding.unmeasured > 0);
  if (unmeasured !== undefined) {
    errLine(
      io,
      `warning: ${plural(unmeasured.unmeasured, "building")} carry an unanchored revision — ` +
        "drawn at the channel minimum there, not at zero.",
    );
  }

  if (options.out !== undefined) {
    io.writeFile(options.out, artifact);
    errLine(io, `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out}.`);
  } else if (assets === undefined) {
    io.out(artifact);
  }

  if (assets !== undefined) {
    deps.startServer({ artifact, assets, port: options.port, host: options.host, io });
  }
  return EXIT.OK;
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}
