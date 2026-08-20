import { commandSpec, parseInvocation, renderHelp, type Invocation } from "./args.js";
import { analyzeCommand } from "./commands/analyze.js";
import { exportCommand } from "./commands/export.js";
import { profilesCommand } from "./commands/profiles.js";
import { validateCommand } from "./commands/validate.js";
import { EXIT, isUsageError, type ExitCode } from "./exit.js";
import { errLine, outLine, type IoSink } from "./io.js";
import { cliVersion } from "./version.js";

/**
 * Dispatch, and THE ONE PLACE an exit code is decided (decision 2).
 *
 * `run` returns a code; it never calls `process.exit`. That keeps stdout
 * flushing to the caller's redirection intact and makes the whole CLI testable
 * in-process — a test calls `run(argv, captureIo())` and asserts on both.
 */
export function run(argv: readonly string[], io: IoSink): ExitCode {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    if (isUsageError(error)) {
      errLine(io, `codegraph: ${error.message}`);
      if (error.hint !== undefined) errLine(io, error.hint);
      return error.exitCode;
    }
    return internalError(io, error);
  }

  try {
    return dispatch(invocation, io);
  } catch (error) {
    // A usage error can also surface from a command (an unreadable model path,
    // an unwritable --out): still exit 2, still no stack trace.
    if (isUsageError(error)) {
      errLine(io, `codegraph: ${error.message}`);
      if (error.hint !== undefined) errLine(io, error.hint);
      return error.exitCode;
    }
    return internalError(io, error);
  }
}

function dispatch(invocation: Invocation, io: IoSink): ExitCode {
  switch (invocation.kind) {
    // Help and --version were REQUESTED: they are this invocation's artifact,
    // so they go to stdout and exit 0. Help printed because something was wrong
    // is a usage error instead, and goes to stderr with exit 2.
    case "help":
      outLine(io, renderHelp(invocation.command));
      return EXIT.OK;
    case "version":
      outLine(io, cliVersion());
      return EXIT.OK;
    case "run":
      switch (invocation.command) {
        case "validate":
          return validateCommand(invocation.options, io);
        case "analyze":
          return analyzeCommand(invocation.options, io);
        case "export":
          return exportCommand(invocation.options, io);
        case "profiles":
          return profilesCommand(invocation.options, io);
      }
  }
}

/**
 * An unexpected throw is a BUG IN CODEGRAPH (exit 1), never a statement about
 * the model (exit 3). The user gets a sentence saying so and the message — not
 * a raw stack trace, which reads as a crash and hides the one useful line.
 */
function internalError(io: IoSink, error: unknown): ExitCode {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  errLine(io, `codegraph: internal error — this is a bug in codegraph, not in your model.`);
  errLine(io, `  ${message}`);
  errLine(io, `Please report it with the command you ran.`);
  return EXIT.INTERNAL;
}

/** Exported for the help/usage path in tests and for `codegraph <cmd> --help`. */
export { commandSpec, renderHelp };
