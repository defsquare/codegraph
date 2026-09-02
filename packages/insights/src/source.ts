import type { SourceAnchor } from "@codegraph/core";

/**
 * SOURCE TEXT FROM ANCHORS. The model carries `{file, span}` per entity — a
 * root-relative path and a 1-based inclusive line range — and nothing in the
 * pipeline has read source text before this. The reader is handed a
 * `readFile` so the package stays free of `node:fs`: the CLI passes the real
 * one rooted at `--src`, tests pass a map.
 *
 * A missing file is a FACT the prompt must state ("source unavailable"), not
 * an exception: a model extracted from one tree and explained against another
 * is a user error that should degrade to weaker explanations, not abort the
 * run halfway through a budget.
 */

export interface SourceSlice {
  readonly file: string;
  readonly span: readonly [number, number];
  /** The lines of the span joined by `\n`; elided in the middle when truncated. */
  readonly text: string;
  readonly truncated: boolean;
  /** True when the file could not be read; `text` is then empty. */
  readonly missing: boolean;
}

export interface SourceReader {
  slice(anchor: SourceAnchor, maxLines: number): SourceSlice;
  /** Files asked for and not found, sorted, distinct — for the run summary. */
  misses(): readonly string[];
}

/** Lines kept at the tail of a truncated slice: enough to see the return and the closing brace. */
const TAIL_LINES = 20;

export function createSourceReader(readFile: (relativePath: string) => string | undefined): SourceReader {
  const cache = new Map<string, readonly string[] | undefined>();
  const missed = new Set<string>();

  const linesOf = (file: string): readonly string[] | undefined => {
    if (cache.has(file)) return cache.get(file);
    const text = readFile(file);
    const lines = text === undefined ? undefined : text.split(/\r?\n/u);
    cache.set(file, lines);
    if (lines === undefined) missed.add(file);
    return lines;
  };

  return {
    slice(anchor, maxLines) {
      const lines = linesOf(anchor.file);
      const span: readonly [number, number] = [anchor.span[0], anchor.span[1]];
      if (lines === undefined) return { file: anchor.file, span, text: "", truncated: false, missing: true };
      const start = Math.max(1, span[0]);
      const end = Math.min(lines.length, span[1]);
      const wanted = lines.slice(start - 1, end);
      const budget = Math.max(3, maxLines);
      if (wanted.length <= budget) {
        return { file: anchor.file, span, text: wanted.join("\n"), truncated: false, missing: false };
      }
      const tail = Math.min(TAIL_LINES, Math.floor(budget / 4));
      const head = budget - tail - 1;
      const elided = wanted.length - head - tail;
      const text = [...wanted.slice(0, head), `// … ${elided} lines elided …`, ...wanted.slice(wanted.length - tail)].join("\n");
      return { file: anchor.file, span, text, truncated: true, missing: false };
    },
    misses: () => [...missed].sort(),
  };
}

/** A `readFile` over an in-memory map — the test double, and the dry-run reader when no `--src` is given. */
export function mapReader(files: ReadonlyMap<string, string>): (relativePath: string) => string | undefined {
  return (path) => files.get(path);
}
