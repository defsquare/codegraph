import { writeFileSync } from "node:fs";
import type { ExitCode } from "./exit.js";
import { UsageError } from "./exit.js";

/**
 * Stream discipline (M4 decision 3) as a testable seam.
 *
 *   out()  = THE ARTIFACT. The report, the DOT, the CSV, the JSON — nothing
 *            else, ever. `codegraph export … --format dot > graph.dot` must
 *            produce a file a dot(1) parser accepts with no human prose in it.
 *   err()  = everything human: progress, warnings, summaries, error messages.
 *            A pipeline that keeps only stdout loses none of the artifact and
 *            none of the diagnosis, because they never share a stream.
 *
 * Commands receive an `IoSink` and never touch `process.stdout`, `console.log`
 * or `fs` themselves: that is what makes every command testable in-process,
 * with no subprocess and no global patching.
 *
 * NO ANSI COLOUR anywhere (decision 4). Output is piped, diffed and committed
 * far more often than it is read on a terminal, and escape codes corrupt all
 * three. There is no colour helper here on purpose — none is wanted.
 */
export interface IoSink {
  /** The artifact stream. Written verbatim; add your own newline. */
  out(text: string): void;
  /** The human stream. Written verbatim; add your own newline. */
  err(text: string): void;
  /**
   * `--out FILE`: the artifact goes to a file instead of stdout. Routed through
   * the sink so a command still cannot write to the process by itself, and so a
   * test can assert on the bytes without touching a disk.
   * Throws {@link UsageError} when the path cannot be written (exit 2).
   */
  writeFile(path: string, text: string): void;
}

/** A command: parsed options in, one exit code out, all output through the sink. */
export type Command<Options> = (options: Options, io: IoSink) => ExitCode;

/**
 * The one exception to "sync all the way down": a command that awaits a
 * network client. It still gets its options and its sink the same way, and
 * `run` settles the promise through the same exit-code mapping — the only
 * difference a caller sees is the `await`.
 */
export type AsyncCommand<Options> = (options: Options, io: IoSink) => Promise<ExitCode>;

/** `out(text + "\n")`, the shape almost every line of a report wants. */
export function outLine(io: IoSink, text = ""): void {
  io.out(`${text}\n`);
}

/** `err(text + "\n")`. */
export function errLine(io: IoSink, text = ""): void {
  io.err(`${text}\n`);
}

/** Write whole lines as one call — one write syscall, one atomic chunk. */
export function outLines(io: IoSink, lines: readonly string[]): void {
  if (lines.length === 0) return;
  io.out(`${lines.join("\n")}\n`);
}

export function errLines(io: IoSink, lines: readonly string[]): void {
  if (lines.length === 0) return;
  io.err(`${lines.join("\n")}\n`);
}

/**
 * EPIPE is not an error worth reporting: `codegraph export … | head` closes the
 * pipe on purpose. Swallow it on the process streams — the alternative is an
 * unhandled 'error' event that crashes with exit 1, i.e. a bug report for
 * something the user did deliberately.
 */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

/** The real sink: stdout, stderr, and the filesystem. Used only by the entry point. */
export function processIo(): IoSink {
  ignoreEpipe(process.stdout);
  ignoreEpipe(process.stderr);
  return {
    out(text: string): void {
      process.stdout.write(text);
    },
    err(text: string): void {
      process.stderr.write(text);
    },
    writeFile(path: string, text: string): void {
      try {
        writeFileSync(path, text, "utf8");
      } catch (error) {
        throw new UsageError(
          `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
          "Check the directory exists and is writable, or drop --out to write to stdout.",
          { cause: error },
        );
      }
    },
  };
}

/** An `IoSink` that records instead of writing. Pass it straight to a command. */
export interface CapturedIo extends IoSink {
  /** Everything written to the artifact stream, concatenated. */
  stdout(): string;
  /** Everything written to the human stream, concatenated. */
  stderr(): string;
  /** stdout split on newlines, trailing empty line dropped. */
  stdoutLines(): readonly string[];
  stderrLines(): readonly string[];
  /** Files a command asked for via `--out`, keyed by path. */
  files(): ReadonlyMap<string, string>;
}

function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function captureIo(): CapturedIo {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const written = new Map<string, string>();

  return {
    out: (text) => void outChunks.push(text),
    err: (text) => void errChunks.push(text),
    writeFile: (path, text) => void written.set(path, text),
    stdout: () => outChunks.join(""),
    stderr: () => errChunks.join(""),
    stdoutLines: () => splitLines(outChunks.join("")),
    stderrLines: () => splitLines(errChunks.join("")),
    files: () => written,
  };
}
