import { Buffer } from "node:buffer";
import { buildGraph, FRAMEWORK_PROFILES } from "@codegraph/analyzer";
import {
  buildCity,
  cityToJsonString,
  layoutCity,
  UnknownMetricError,
  UnknownScaleError,
  type CityModel,
} from "@codegraph/city";
import type { CityBuildOptions, CityOptions } from "../args.js";
import { UsageError, type ExitCode } from "../exit.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { loadExitCode, loadModelFiles } from "../load.js";
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
 * LAYOUT IS OPT-IN. Without `--layout` the artifact has no coordinates —
 * dimensions, not placement. With it, `layoutCity` adds `position` to every
 * building and `bounds` to every district (recursive shelf packing, readability
 * over density); the packer and its parameters ship in the artifact's `layout`
 * block. The city model itself is unchanged either way.
 *
 * A BAD METRIC IS A USAGE ERROR (exit 2), not an internal one: the city package
 * throws `UnknownMetricError` naming what exists, and the CLI's job is to hand
 * that to the user with the flag they typed.
 *
 * To LOOK at the city, `codegraph serve` — the page that hosts it as a tab
 * beside the navigator; this command only writes the artifact.
 */
export function cityCommand(options: CityOptions, io: IoSink): ExitCode {
  const loaded = loadModelFiles(options.models);
  const graph = buildGraph(loaded.union);

  const city = cityOf(graph, options);
  const laidOut = options.layout;
  const artifact = cityToJsonString(laidOut ? layoutCity(city) : city);

  errLines(io, cityWarnings(loaded, city));

  if (options.out !== undefined) {
    io.writeFile(options.out, artifact);
    errLine(
      io,
      `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out} ` +
        `(${describe(city, laidOut)}).`,
    );
  } else {
    io.out(artifact);
  }

  return loadExitCode(loaded);
}

/** The city of a graph under the CLI's flags — shared with `serve`. */
export function cityOf(graph: ReturnType<typeof buildGraph>, options: CityBuildOptions): CityModel {
  try {
    const framework =
      options.framework === undefined ? undefined : FRAMEWORK_PROFILES[options.framework];
    return buildCity(graph, {
      view: resolveView(options),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(framework === undefined ? {} : { framework }),
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
function describe(city: CityModel, laidOut: boolean): string {
  const channels = city.bindings.map((binding) => `${binding.channel}=${binding.metric}`).join(", ");
  return (
    `city, view ${city.view.name}, ${plural(city.districts.length, "district")}, ` +
    `${plural(city.buildings.length, "building")}, ${plural(city.arrows.length, "arrow")}, ` +
    `${channels}${laidOut ? ", laid out" : ""}`
  );
}

/**
 * Everything that makes the city smaller or vaguer than the model, on stderr. A
 * city that quietly omits buildings is how a wrong impression of a codebase
 * gets believed. Shared with `serve`, which passes `clean: true` and states
 * the models' cleanliness once for the whole page.
 */
export function cityWarnings(
  loaded: { readonly clean: boolean; readonly paths: readonly string[] },
  city: CityModel,
): readonly string[] {
  const lines: string[] = [];

  if (!loaded.clean) {
    lines.push(
      `warning: the models are not clean; the city was built anyway.`,
      `Run 'codegraph validate ${loaded.paths.join(" ")}' for the detail.`,
    );
  }

  if (city.roles !== undefined) {
    const classified = city.buildings.filter((building) => building.role !== undefined).length;
    lines.push(
      `note: ${city.roles.framework} classified ${plural(classified, "building")} into ` +
        `${city.roles.values.join(", ") || "no role"} — an inference from written annotations, ` +
        `not a fact about the code.`,
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
