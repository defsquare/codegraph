import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * COMMITTED GOLDEN FILES, compared byte for byte. `CODEGRAPH_UPDATE_SNAPSHOTS`
 * set (any value, the vocabulary snapshots' convention) rewrites them instead
 * of comparing; a plain run only ever reads them. A mismatch names the file,
 * the first differing line, both versions of it, and the section it sits in.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export const UPDATING = process.env["CODEGRAPH_UPDATE_SNAPSHOTS"] !== undefined;

export class GoldenMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenMismatch";
  }
}

/** `actual` must equal the committed file; `isHeading` marks the lines a mismatch is located under. */
export function expectGolden(path: string, actual: string, isHeading: (line: string) => boolean = () => false): void {
  const shown = relative(REPO, path);
  if (UPDATING) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  if (!existsSync(path)) {
    throw new GoldenMismatch(`golden ${shown} is not committed. Write it with CODEGRAPH_UPDATE_SNAPSHOTS=1 and review it before committing.`);
  }
  const expected = readFileSync(path, "utf8");
  if (expected !== actual) throw new GoldenMismatch(firstDifference(shown, expected, actual, isHeading));
}

/** The first line that differs, located: what a reader needs to tell WHAT moved without a byte diff. */
export function firstDifference(shown: string, expected: string, actual: string, isHeading: (line: string) => boolean): string {
  const want = expected.split("\n");
  const got = actual.split("\n");
  let index = 0;
  while (index < want.length && index < got.length && want[index] === got[index]) index += 1;
  const heading = [...want.slice(0, index + 1)].reverse().find(isHeading);
  const before = want[index];
  const after = got[index];
  const column = before === undefined || after === undefined ? 0 : commonPrefix(before, after);
  return [
    `golden ${shown} differs at line ${index + 1}${column > 0 ? `, column ${column + 1}` : ""} (expected ${want.length} lines, got ${got.length}).`,
    ...(heading === undefined || heading === before ? [] : [`  under: ${clip(heading, 0)}`]),
    `  expected: ${before === undefined ? "<end of file>" : clip(before, column)}`,
    `  actual:   ${after === undefined ? "<end of file>" : clip(after, column)}`,
    "If the change is intended, rewrite the goldens with CODEGRAPH_UPDATE_SNAPSHOTS=1 and review the diff: default explain must stay byte-identical (PLAN.md §22).",
  ].join("\n");
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** A long line shown around the column where it starts to differ. */
function clip(line: string, column: number): string {
  const WIDTH = 240;
  if (line.length <= WIDTH) return JSON.stringify(line);
  const start = Math.max(0, Math.min(column - 60, line.length - WIDTH));
  return `${start > 0 ? "…" : ""}${JSON.stringify(line.slice(start, start + WIDTH))}${start + WIDTH < line.length ? "…" : ""}`;
}
