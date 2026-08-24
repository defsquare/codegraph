import { describe, expect, it } from "vitest";
import { GitLogParseError, parseGitLog } from "../src/gitlog.js";

/**
 * The parser is tested against BYTES GIT ACTUALLY EMITS: `CAPTURE` below is
 * the verbatim output of the `gitLogArgs` invocation on a scripted repo
 * (two authors, a fix, a rename, a deletion), captured once and frozen. The
 * synthetic cases then exercise what the small repo cannot: rename chains,
 * binary files, empty commits, garbage.
 */

const META = { repo: "probe", miner: "codegraph-scm@test" } as const;

const H1 = "64ce666c5885be6b40aacd5144e7d3baaac8d3bb"; // feat: one        (oldest)
const H2 = "8f318bc11a75eb0b257a98d8545bcb4bfad1a425"; // fix: bug in one
const H3 = "0e460bad24a2e67d3bc1e7cf33beeae26b71b8ea"; // refactor: rename one to two
const H4 = "bd1ed36d2c844083a38a4c38a457c641b684ff97"; // chore: drop two  (newest)

/** Verbatim `git log --numstat -z --pretty=…` bytes, newest commit first. */
const CAPTURE =
  `\x01${H4}\x01Bob <bob@example.com>\x011704362400\x01chore: drop two\x01\n` +
  `0\t5\tsrc/two.txt\x00\x00` +
  `\x01${H3}\x01Bob <bob@example.com>\x011704276000\x01refactor: rename one to two\x01\n` +
  `1\t0\t\x00src/one.txt\x00src/two.txt\x00\x00` +
  `\x01${H2}\x01Bob <bob@example.com>\x011704189600\x01fix: bug in one\x01\n` +
  `1\t0\tsrc/one.txt\x00\x00` +
  `\x01${H1}\x01Alice <alice@example.com>\x011704103200\x01feat: one\x01\n` +
  `3\t0\tsrc/one.txt\x00`;

describe("parsing real git output", () => {
  const history = parseGitLog(CAPTURE, META);

  it("orders commits oldest first, by (time, hash)", () => {
    expect(history.commits.map((commit) => commit.hash)).toEqual([H1, H2, H3, H4]);
    expect(history.commits.map((commit) => commit.time)).toEqual([
      1704103200, 1704189600, 1704276000, 1704362400,
    ]);
  });

  it("interns authors sorted", () => {
    expect(history.authors).toEqual(["Alice <alice@example.com>", "Bob <bob@example.com>"]);
    expect(history.commits.map((commit) => history.authors[commit.author])).toEqual([
      "Alice <alice@example.com>",
      "Bob <bob@example.com>",
      "Bob <bob@example.com>",
      "Bob <bob@example.com>",
    ]);
  });

  it("resolves the rename into ONE lineage, named by the newest path", () => {
    expect(history.paths).toEqual(["src/two.txt"]);
    // Every change lands on the same surrogate, including pre-rename ones.
    expect(history.changes.map((change) => change.path)).toEqual([0, 0, 0, 0]);
  });

  it("keeps the literal pre-rename path on the renaming change", () => {
    const renamed = history.changes.filter((change) => change.renamedFrom !== undefined);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.renamedFrom).toBe("src/one.txt");
    expect(history.commits[renamed[0]?.commit as number]?.hash).toBe(H3);
  });

  it("carries the numstat line deltas", () => {
    expect(history.changes.map((change) => [change.added, change.deleted])).toEqual([
      [3, 0],
      [1, 0],
      [1, 0],
      [0, 5],
    ]);
  });

  it("labels the fix commit — and only it", () => {
    expect(history.commits.map((commit) => commit.isFix)).toEqual([false, true, false, false]);
    expect(history.commits.every((commit) => !commit.isRevert)).toBe(true);
  });

  it("stamps the artifact metadata", () => {
    expect(history.repo).toBe("probe");
    expect(history.scm).toBe("git");
    expect(history.miner).toBe("codegraph-scm@test");
  });
});

// -------------------------------------------------------------- synthetic

const HASHES = Array.from({ length: 8 }, (_, index) => String(index).repeat(40));

function header(hash: string, author: string, time: number, subject: string): string {
  return `\x01${hash}\x01${author}\x01${time}\x01${subject}\x01\n`;
}

describe("synthetic edge cases", () => {
  it("follows a rename CHAIN a → b → c into one lineage", () => {
    const raw =
      header(HASHES[3] as string, "A <a@x>", 400, "touch c") +
      `2\t0\tc.txt\x00\x00` +
      header(HASHES[2] as string, "A <a@x>", 300, "rename b to c") +
      `0\t0\t\x00b.txt\x00c.txt\x00\x00` +
      header(HASHES[1] as string, "A <a@x>", 200, "rename a to b") +
      `0\t0\t\x00a.txt\x00b.txt\x00\x00` +
      header(HASHES[0] as string, "A <a@x>", 100, "create a") +
      `5\t0\ta.txt\x00`;
    const history = parseGitLog(raw, META);
    expect(history.paths).toEqual(["c.txt"]);
    expect(history.changes.map((change) => change.path)).toEqual([0, 0, 0, 0]);
    expect(history.changes.map((change) => change.renamedFrom)).toEqual([
      undefined,
      "a.txt",
      "b.txt",
      undefined,
    ]);
  });

  it("counts binary files as changes with zero lines", () => {
    const raw = header(HASHES[0] as string, "A <a@x>", 100, "add logo") + `-\t-\tlogo.png\x00`;
    const history = parseGitLog(raw, META);
    expect(history.changes).toEqual([{ commit: 0, path: 0, added: 0, deleted: 0 }]);
  });

  it("survives a commit that touches no files", () => {
    const raw =
      header(HASHES[1] as string, "A <a@x>", 200, "empty") +
      header(HASHES[0] as string, "A <a@x>", 100, "real") +
      `1\t0\ta.txt\x00`;
    const history = parseGitLog(raw, META);
    expect(history.commits).toHaveLength(2);
    expect(history.changes).toHaveLength(1);
  });

  it("labels reverts by the leading word only", () => {
    const raw =
      header(HASHES[1] as string, "A <a@x>", 200, 'Revert "feat: x"') +
      header(HASHES[0] as string, "A <a@x>", 100, "do not revert this") ;
    const history = parseGitLog(raw, META);
    expect(history.commits.map((commit) => commit.isRevert)).toEqual([false, true]);
  });

  it("parses an empty log as an empty history", () => {
    const history = parseGitLog("", META);
    expect(history.commits).toEqual([]);
    expect(history.paths).toEqual([]);
    expect(history.authors).toEqual([]);
  });

  it("refuses bytes that are not git log output", () => {
    expect(() => parseGitLog("hello world", META)).toThrow(GitLogParseError);
    expect(() => parseGitLog(`\x01nothex\x01A\x01100\x01s\x01\n`, META)).toThrow(GitLogParseError);
  });

  it("merges two lineages that reuse one path, without losing churn", () => {
    // d.txt deleted, then a NEW d.txt created later: path identity merges
    // them into one lineage — the documented v1 approximation.
    const raw =
      header(HASHES[2] as string, "A <a@x>", 300, "recreate d") +
      `4\t0\td.txt\x00\x00` +
      header(HASHES[1] as string, "A <a@x>", 200, "delete d") +
      `0\t2\td.txt\x00\x00` +
      header(HASHES[0] as string, "A <a@x>", 100, "create d") +
      `2\t0\td.txt\x00`;
    const history = parseGitLog(raw, META);
    expect(history.paths).toEqual(["d.txt"]);
    expect(history.changes).toHaveLength(3);
  });
});
