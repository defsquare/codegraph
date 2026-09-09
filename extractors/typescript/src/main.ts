import { closeSync, openSync, writeSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { extract } from "./extraction.js";
import { encode, plannedRecords } from "./model/writer.js";
import { parseOptions, UsageError, usage } from "./options.js";
import { Progress, type Sink } from "./progress.js";

export const VERSION: string = pkg.version;

export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2, UNIMPLEMENTED: 3 } as const;

export interface Io {
  readonly stdout: Sink;
  readonly stderr: Sink;
}

/**
 * The extractor as a function: argv in, exit code out, every byte through
 * `io`. stdout carries nothing but `--help`/`--version`; progress and the
 * summary go to stderr, so a redirected run is byte-identical to a silent one.
 */
export function run(args: readonly string[], io: Io, cwd: string): number {
  let options;
  try {
    options = parseOptions(args, cwd);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`error: ${error.message}\n\n${usage(VERSION)}`);
      return EXIT.USAGE;
    }
    throw error;
  }
  if (options.help) {
    io.stdout.write(usage(VERSION));
    return EXIT.OK;
  }
  if (options.version) {
    io.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  try {
    const progress = new Progress(options.progress, io.stderr);
    const result = extract(
      {
        sources: options.sources,
        cwd,
        repository: options.repository,
        tsconfig: options.tsconfig,
        allowJs: options.allowJs,
        ignoreNodeModules: options.ignoreNodeModules,
      },
      progress,
      VERSION,
    );
    progress.phase("write", () => writeLines(options.out, encode(result.model)), () => `${plannedRecords(result.model)} records`);
    for (const conflict of result.corpus.configConflicts) {
      io.stderr.write(`tsconfig not applied (another root's won): ${conflict}\n`);
    }
    for (const duplicate of result.stats.duplicateKeys) io.stderr.write(`duplicate declaration re-keyed: ${duplicate}\n`);
    for (const dropped of result.stats.unclosableEdgesDropped) io.stderr.write(`unclosable edge dropped: ${dropped}\n`);
    io.stderr.write(result.stats.summary(result.model.entities.length, result.stubs, result.model.edges.length));
    io.stderr.write(`wrote ${options.out}\n`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`error: ${error.message}\n`);
      return EXIT.USAGE;
    }
    io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.FAILURE;
  }
}

/** Lines to disk in 1MB chunks: never one string for the whole model. */
function writeLines(path: string, lines: Iterable<string>): void {
  const fd = openSync(path, "w");
  try {
    let chunk = "";
    for (const line of lines) {
      chunk += `${line}\n`;
      if (chunk.length >= 1 << 20) {
        writeSync(fd, chunk);
        chunk = "";
      }
    }
    if (chunk.length > 0) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}

export function processIo(): Io {
  return {
    stdout: { write: (text) => void process.stdout.write(text), isTerminal: process.stdout.isTTY === true },
    stderr: { write: (text) => void process.stderr.write(text), isTerminal: process.stderr.isTTY === true },
  };
}
