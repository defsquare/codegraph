import type { ExportOptions } from "../args.js";
import type { ExitCode } from "../exit.js";
import type { IoSink } from "../io.js";

/**
 * M4 SEAM — `codegraph export <model.json...> --format dot|json|csv`.
 *
 * The contract this implementation must honour:
 *  - Same pipeline as `analyze` up to the folded graph, then `toDot` /
 *    `foldedGraphToJson` + `toJsonString` / `foldedGraphToCsv`.
 *  - THE ARTIFACT IS THE ONLY THING ON STDOUT (decision 3):
 *    `codegraph export m.json --format dot > graph.dot` must yield a file dot(1)
 *    parses, with no summary line, no warning, no ANSI. Warnings go to stderr.
 *  - `--out FILE` writes through `io.writeFile(path, text)` and prints nothing
 *    on stdout; the command never touches `fs` itself.
 *  - Byte-identical output for identical input and flags (decision 6) — the
 *    exporters already sort; do not reorder their result.
 *  - Exit: `EXIT.FINDINGS` when the load was not clean (the artifact is still
 *    written — a bad model is exactly when a picture helps), else `EXIT.OK`.
 */
export function exportCommand(options: ExportOptions, io: IoSink): ExitCode {
  void options;
  void io;
  throw new Error("M4: export fills this in");
}
