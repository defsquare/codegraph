import type { AnalyzeOptions } from "../args.js";
import type { ExitCode } from "../exit.js";
import type { IoSink } from "../io.js";

/**
 * M4 SEAM — `codegraph analyze <model.json...> --report deps|cycles|coupling`.
 *
 * The contract this implementation must honour:
 *  - `loadModelFiles` -> `buildGraph(union)` -> `resolveView(options)` ->
 *    `foldGraph(graph, { level: options.level, view })`, then the analyzer's
 *    `coupling` / `cycles` / import-or-type-dependency query. The CLI computes
 *    no graph fact of its own and never parses an EntityId (decision 7).
 *  - `--report deps` at module level is the import graph; at type level the
 *    type-dependency graph.
 *  - `--top N` limits ROWS SHOWN, never what was computed; `topByFanIn` /
 *    `topByFanOut` exist for that.
 *  - Every result states the level and the view it was computed under: a
 *    coupling number without its view is not a fact.
 *  - `--json` puts one object on stdout carrying the SAME information as the
 *    text form (decision 8). Human framing stays on stderr.
 *  - Exit: `EXIT.FINDINGS` when the load was not clean (report anyway), else
 *    `EXIT.OK`. A cycle is a finding of the model, so a non-empty cycle report
 *    also returns `EXIT.FINDINGS`.
 */
export function analyzeCommand(options: AnalyzeOptions, io: IoSink): ExitCode {
  void options;
  void io;
  throw new Error("M4: analyze fills this in");
}
