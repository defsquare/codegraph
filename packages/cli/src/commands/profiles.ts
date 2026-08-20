import type { ProfilesOptions } from "../args.js";
import type { ExitCode } from "../exit.js";
import type { IoSink } from "../io.js";

/**
 * M4 SEAM — `codegraph profiles [--lang java] [--json]`.
 *
 * The contract this implementation must honour:
 *  - Read `PROFILES` / `getProfile(lang)` from `@codegraph/core`. Profiles are
 *    DATA (CLAUDE.md invariant 8): print them, never synthesize one.
 *  - No `--lang`: list every shipped profile. With `--lang`: print that
 *    profile's kinds (required/optional traits), edge kinds, spaces and notes.
 *  - An unknown `--lang` is a USAGE error (exit 2) naming the languages that do
 *    exist — no model was involved, so it cannot be a finding.
 *  - `--json` prints the profile object(s) on stdout; deterministic key and
 *    array order.
 *  - This command reads no model, so its only success code is `EXIT.OK`.
 */
export function profilesCommand(options: ProfilesOptions, io: IoSink): ExitCode {
  void options;
  void io;
  throw new Error("M4: profiles fills this in");
}
