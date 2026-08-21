import { Buffer } from "node:buffer";
import { buildGraph } from "@codegraph/analyzer";
import {
  buildCity,
  cityToJsonString,
  UnknownMetricError,
  UnknownScaleError,
  type CityModel,
} from "@codegraph/city";
import type { CityOptions } from "../args.js";
import { UsageError, type ExitCode } from "../exit.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { loadExitCode, loadModelFiles, type LoadedModels } from "../load.js";
import { resolveView } from "../view.js";

/**
 * `codegraph city <model.jsonl...> [--height METRIC] [--footprint METRIC]`.
 *
 * Writes the CITY MODEL — modules as districts, types as buildings, type
 * dependencies as roof-to-roof arrows — as JSON on stdout, or to `--out FILE`.
 * The transform lives in `@codegraph/city`; this command only resolves flags,
 * loads models and moves bytes (decision 7).
 *
 * STREAM PURITY (decision 3): with no `--out`, stdout carries the artifact and
 * nothing else, so `codegraph city m.jsonl > city.json` yields a file a JSON
 * parser accepts. Warnings and the `--out` confirmation are stderr.
 *
 * NO LAYOUT. The artifact has no coordinates by design — dimensions, not
 * placement. A later layout / bin-packing pass consumes each district's
 * `footprintDemand`; this command will not grow a `--layout` flag until that
 * pass exists, because a flag that positions nothing would be a promise the
 * model cannot keep.
 *
 * A BAD METRIC IS A USAGE ERROR (exit 2), not an internal one: the city package
 * throws `UnknownMetricError` naming what exists, and the CLI's job is to hand
 * that to the user with the flag they typed.
 */
export function cityCommand(options: CityOptions, io: IoSink): ExitCode {
  const loaded = loadModelFiles(options.models);
  const graph = buildGraph(loaded.union);

  const city = build(graph, options);
  const artifact = cityToJsonString(city);

  errLines(io, warnings(loaded, city));

  if (options.out === undefined) {
    io.out(artifact);
  } else {
    io.writeFile(options.out, artifact);
    errLine(
      io,
      `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out} ` +
        `(${describe(city)}).`,
    );
  }

  return loadExitCode(loaded);
}

function build(graph: ReturnType<typeof buildGraph>, options: CityOptions): CityModel {
  try {
    return buildCity(graph, {
      view: resolveView(options),
      height: { metric: options.height, scale: options.heightScale },
      footprint: { metric: options.footprint, scale: options.footprintScale },
      carry: options.carry,
    });
  } catch (error) {
    if (error instanceof UnknownMetricError || error instanceof UnknownScaleError) {
      throw new UsageError(error.message, "Run 'codegraph city --help' for the metrics and scales.");
    }
    throw error;
  }
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}

/** What the artifact is, for the human stream only. */
function describe(city: CityModel): string {
  const channels = city.bindings.map((binding) => `${binding.channel}=${binding.metric}`).join(", ");
  return (
    `city, view ${city.view.name}, ${plural(city.districts.length, "district")}, ` +
    `${plural(city.buildings.length, "building")}, ${plural(city.arrows.length, "arrow")}, ${channels}`
  );
}

/**
 * Everything that makes the city smaller or vaguer than the model, on stderr. A
 * city that quietly omits buildings is how a wrong impression of a codebase
 * gets believed.
 */
function warnings(loaded: LoadedModels, city: CityModel): readonly string[] {
  const lines: string[] = [];

  if (!loaded.clean) {
    lines.push(
      `warning: the models are not clean; the city was built anyway.`,
      `Run 'codegraph validate ${loaded.paths.join(" ")}' for the detail.`,
    );
  }

  const unplaced = city.diagnostics.unplacedBuildings.length;
  if (unplaced > 0) {
    lines.push(
      `warning: ${plural(unplaced, "type")} left out — the model gives them no module, ` +
        `so there is no district to stand them in.`,
    );
  }
  if (city.diagnostics.droppedArrows > 0) {
    lines.push(
      `warning: ${plural(city.diagnostics.droppedArrows, "arrow")} dropped — an endpoint is not ` +
        `a building in this view.`,
    );
  }

  // An unmeasured building is floored, not zeroed. Saying so is what keeps
  // "shortest" from being read as "smallest".
  for (const binding of city.bindings) {
    if (binding.unmeasured === 0) continue;
    lines.push(
      `warning: ${binding.channel} is unmeasured on ${plural(binding.unmeasured, "building")} ` +
        `(metric ${binding.metric}) — those are drawn at the channel minimum, not at zero.`,
    );
  }

  return lines;
}
