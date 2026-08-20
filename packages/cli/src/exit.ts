/**
 * Exit codes (M4 decision 2). CI must be able to tell "the tool broke" from
 * "the model is bad", so those two are never the same number:
 *
 *   0 OK        the command did what it was asked, nothing to report
 *   1 INTERNAL  an unexpected throw — a bug in codegraph itself
 *   2 USAGE     unknown command or flag, missing argument, unreadable file
 *   3 FINDINGS  the tool worked perfectly; the INPUT is invalid or a property
 *               failed. A job gating on model quality checks for exactly this.
 *
 * Conflating 1 and 3 would make a crash look like a bad model and vice versa,
 * so `main` is the single place that maps an outcome onto one of these.
 */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  FINDINGS: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A mistake in the INVOCATION, not in the model: unknown command, unknown flag,
 * missing required option, a path that cannot be read. Always exit 2, and the
 * message names what would have been valid — an error that only says "no" costs
 * the user another round trip.
 *
 * Findings are NOT thrown: a model that violates its profile is a normal result
 * the command reports and returns `EXIT.FINDINGS` for.
 */
export class UsageError extends Error {
  readonly exitCode: ExitCode = EXIT.USAGE;
  /** Optional second paragraph: the valid options, the command list, `--help`. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UsageError";
    this.hint = hint;
  }
}

export function isUsageError(error: unknown): error is UsageError {
  return error instanceof UsageError;
}
