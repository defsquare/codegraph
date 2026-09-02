import { commandSpec, parseInvocation, renderHelp, type Invocation } from "./args.js";
import { analyzeCommand } from "./commands/analyze.js";
import { cityCommand } from "./commands/city.js";
import { exportCommand } from "./commands/export.js";
import { historyCommand } from "./commands/history.js";
import { importCommand } from "./commands/import.js";
import { domainFactsCommand } from "./commands/domain-facts.js";
import { navigatorCommand } from "./commands/navigator.js";
import { scmCommand } from "./commands/scm.js";
import { snapshotsCommand } from "./commands/snapshots.js";
import { timelineCommand } from "./commands/timeline.js";
import { replayCommand } from "./commands/replay.js";
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
 *
 * SYNC BY DEFAULT, ASYNC BY EXCEPTION. Every command that reads a model and
 * writes an artifact is synchronous all the way down (see core's jsonl-file.ts
 * for why), and `run` returns a plain number for them — the 700+ in-process
 * tests depend on that. The one command that awaits a network client
 * (`explain`) returns a promise instead, and `run` settles it through the same
 * exit-code mapping, so a rejected promise is never an unhandled rejection.
 */
export function run(argv: readonly string[], io: IoSink): ExitCode | Promise<ExitCode> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    return failure(io, error);
  }

  try {
    const outcome = dispatch(invocation, io);
    return outcome instanceof Promise ? outcome.catch((error: unknown) => failure(io, error)) : outcome;
  } catch (error) {
    return failure(io, error);
  }
}

/**
 * `run` for callers that know the command is synchronous — every in-process
 * test helper. A promise here means a test invoked the one async command
 * through a sync helper, which is a test bug, so it throws instead of leaking
 * an unsettled promise into an exit-code assertion.
 */
export function runSync(argv: readonly string[], io: IoSink): ExitCode {
  const outcome = run(argv, io);
  if (outcome instanceof Promise) {
    throw new Error(`codegraph ${argv[0] ?? ""} is asynchronous: await run(...) instead of runSync`);
  }
  return outcome;
}

/**
 * The single mapping from a thrown error to an exit code. A usage error can
 * surface from the parser or from a command (an unreadable model path, an
 * unwritable --out, a missing API key): still exit 2, still no stack trace.
 */
export function failure(io: IoSink, error: unknown): ExitCode {
  if (isUsageError(error)) {
    errLine(io, `codegraph: ${error.message}`);
    if (error.hint !== undefined) errLine(io, error.hint);
    return error.exitCode;
  }
  return internalError(io, error);
}

function dispatch(invocation: Invocation, io: IoSink): ExitCode | Promise<ExitCode> {
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
        case "import":
          return importCommand(invocation.options, io);
        case "export":
          return exportCommand(invocation.options, io);
        case "city":
          return cityCommand(invocation.options, io);
        case "navigator":
          return navigatorCommand(invocation.options, io);
        case "domain-facts":
          return domainFactsCommand(invocation.options, io);
        case "scm":
          return scmCommand(invocation.options, io);
        case "snapshots":
          return snapshotsCommand(invocation.options, io);
        case "history":
          return historyCommand(invocation.options, io);
        case "timeline":
          return timelineCommand(invocation.options, io);
        case "replay":
          return replayCommand(invocation.options, io);
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
