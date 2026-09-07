import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  joinOnPaths,
  listRevisions,
  openStore,
  readEntityHistory,
  storePathFor,
} from "@codegraph/analyzer";
import {
  buildEntityCity,
  cityToJsonString,
  layoutReplayCity,
  type CoChangedFiles,
  type OwnerRef,
} from "@codegraph/city";
import { HistoryError, decodeHistoryText, fileOwners, logicalCoupling } from "@codegraph/scm";
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
      "Build a temporal store first: codegraph snapshots <repo> --extractor <extractor> --tags " +
        `--store ${storePath}`,
      { cause: error },
    );
  }

  let history: ReturnType<typeof readEntityHistory>;
  try {
    if (listRevisions(db).length === 0) {
      throw new UsageError(
        `${storePath} holds no revisions — it is a plain single-model cache`,
        "Append snapshots with: codegraph snapshots <repo> --extractor <extractor> --tags " +
          `--store ${storePath}`,
      );
    }
    history = readEntityHistory(db);
  } finally {
    db.close();
  }

  const name = options.name ?? basename(storePath).replace(/\.db$/, "");
  const joined = options.history === undefined ? undefined : joinHistory(options.history, history, io);
  // `history` already carries the store's repository facts (M10a); the city
  // only forwards them, and the viewer projects the per-tick permalink.
  const city = buildEntityCity(history, {
    name,
    ...(joined === undefined ? {} : { owners: joined.owners, coChange: joined.coChange }),
  });
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

/**
 * The history join (`--history`): scm derives per-lineage owners and the
 * co-change pairs, the analyzer's SUFFIX join maps lineage paths onto the
 * store's anchor files (model roots sit below repo roots), and the builders
 * receive both in MODEL-file terms. Ambiguous suffixes join nothing and are
 * counted — never guessed.
 */
function joinHistory(
  path: string,
  history: ReturnType<typeof readEntityHistory>,
  io: IoSink,
): { owners: ReadonlyMap<string, OwnerRef>; coChange: readonly CoChangedFiles[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "Mine it first: codegraph scm <repo> --out " + path,
      { cause: error },
    );
  }
  let mined;
  try {
    mined = decodeHistoryText(text);
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    throw new UsageError(`${path} is not a history.jsonl: ${error.message}`, undefined, {
      cause: error,
    });
  }

  const modelFiles = new Set<string>();
  for (const entity of history.entities) {
    if (entity.file !== null) modelFiles.add(entity.file);
  }
  const join = joinOnPaths(modelFiles, mined.paths);

  const owners = new Map<string, OwnerRef>();
  for (const [historyPath, owner] of fileOwners(mined)) {
    const modelFile = join.modelOf.get(historyPath);
    if (modelFile !== undefined) owners.set(modelFile, owner);
  }

  const coChange: CoChangedFiles[] = [];
  for (const row of logicalCoupling(mined).rows) {
    const a = join.modelOf.get(row.a);
    const b = join.modelOf.get(row.b);
    if (a === undefined || b === undefined) continue;
    coChange.push({ a, b, support: row.support, confidence: row.confidence });
  }

  errLine(
    io,
    `joined ${path}: ${join.modelOf.size} of ${modelFiles.size} store files matched, ` +
      `${owners.size} owned, ${plural(coChange.length, "co-change pair")}` +
      (join.ambiguous.length === 0
        ? "."
        : `; ${plural(join.ambiguous.length, "ambiguous path")} joined nothing.`),
  );
  return { owners, coChange };
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}
