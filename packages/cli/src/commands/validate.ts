import type { ValidateOptions } from "../args.js";
import type { ExitCode } from "../exit.js";
import type { IoSink } from "../io.js";

/**
 * M4 SEAM — `codegraph validate <model.json...> [--json]`.
 *
 * The contract this implementation must honour:
 *  - Load with `loadModelFiles(options.models)`; a load throw is already a
 *    usage error (exit 2) and must NOT be caught here.
 *  - Report the diagnostics core and the analyzer produced — schema errors,
 *    profile issues (by `code`), dangling references, self-edges, conflicting
 *    duplicate ids. Never re-implement a check (decision 7).
 *  - stdout carries the report (text, or one JSON object under `--json`);
 *    progress and summaries go to stderr (decision 3). Same information either
 *    way (decision 8).
 *  - Return `loadExitCode(loaded)`: `EXIT.OK` when clean, `EXIT.FINDINGS` when
 *    the model is invalid. Never `EXIT.INTERNAL` — that is for bugs.
 *  - Output is deterministic: sort with the analyzer's ordering helpers.
 */
export function validateCommand(options: ValidateOptions, io: IoSink): ExitCode {
  void options;
  void io;
  throw new Error("M4: validate fills this in");
}
