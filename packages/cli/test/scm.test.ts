import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeHistoryText } from "@codegraph/scm";

import { historyCommand, type ServeDeps } from "../src/commands/history.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `codegraph scm` + `codegraph history`, end to end against a SCRIPTED git
 * repository built here in a temp dir (PLAN §11.1): two authors, a rename
 * chain, a `fix:` commit, a deletion — deterministic because every date and
 * identity is pinned through the environment. The M9a DoD lives in this file:
 * miner output byte-identical across runs, and every report number below is
 * hand-counted from the script.
 *
 * The script:
 *   c1 2024-01-01 Alice  feat: one            src/one.txt +3   docs/readme.md +2
 *   c2 2024-01-02 Bob    fix: off by one      src/one.txt +1
 *   c3 2024-01-03 Bob    refactor: rename     src/one.txt -> src/two.txt, +1
 *   c4 2024-01-04 Alice  chore: drop readme   docs/readme.md -2
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-scm-"));
const repo = join(scratch, "demo-repo");
const historyPath = join(scratch, "mined-history.jsonl");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(args: readonly string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-C", repo, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
  });
}

function commit(subject: string, author: "alice" | "bob", date: string): void {
  const name = author === "alice" ? "Alice" : "Bob";
  const email = `${author}@example.com`;
  git(["commit", "-q", "--no-verify", "-m", subject], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
}

beforeAll(() => {
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);

  writeFileSync(join(repo, "src/one.txt"), "a\nb\nc\n");
  writeFileSync(join(repo, "docs/readme.md"), "hello\nworld\n");
  git(["add", "."]);
  commit("feat: one", "alice", "2024-01-01T10:00:00+00:00");

  writeFileSync(join(repo, "src/one.txt"), "a\nb\nc\nd\n");
  git(["add", "."]);
  commit("fix: off by one", "bob", "2024-01-02T10:00:00+00:00");

  git(["mv", "src/one.txt", "src/two.txt"]);
  writeFileSync(join(repo, "src/two.txt"), "a\nb\nc\nd\ne\n");
  git(["add", "."]);
  commit("refactor: rename one to two", "bob", "2024-01-03T10:00:00+00:00");

  git(["rm", "-q", "docs/readme.md"]);
  commit("chore: drop readme", "alice", "2024-01-04T10:00:00+00:00");
});

function invoke(argv: readonly string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = runSync(argv, io);
  return { io, code };
}

function mineTo(out: string): { io: CapturedIo; code: number; bytes: string } {
  const result = invoke(["scm", repo, "--out", out]);
  return { ...result, bytes: result.io.files().get(out) ?? "" };
}

describe("codegraph scm mines the scripted repo", () => {
  it("writes a valid history.jsonl whose facts match the script", () => {
    const { code, bytes } = mineTo(historyPath);
    expect(code).toBe(EXIT.OK);
    const history = decodeHistoryText(bytes);

    expect(history.repo).toBe("demo-repo");
    expect(history.scm).toBe("git");
    expect(history.authors).toEqual(["Alice <alice@example.com>", "Bob <bob@example.com>"]);
    // ONE lineage for one.txt/two.txt: the rename resolved at mine time.
    expect(history.paths).toEqual(["docs/readme.md", "src/two.txt"]);
    expect(history.commits).toHaveLength(4);
    expect(history.commits.map((c) => c.isFix)).toEqual([false, true, false, false]);
    expect(history.changes).toHaveLength(5);

    const renamed = history.changes.filter((c) => c.renamedFrom !== undefined);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.renamedFrom).toBe("src/one.txt");

    // Write it to disk for the report tests below.
    writeFileSync(historyPath, bytes, "utf8");
  });

  it("is byte-identical across runs — the DoD", () => {
    const first = mineTo(join(scratch, "run-a.jsonl")).bytes;
    const second = mineTo(join(scratch, "run-b.jsonl")).bytes;
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("keeps stdout free of timings; the run report goes to stderr", () => {
    const { io } = mineTo(join(scratch, "run-c.jsonl"));
    expect(io.stdout()).not.toMatch(/\ds\b| s,/);
    expect(io.stderr()).toContain("mined in");
    expect(io.stdout()).toContain("4 commits by 2 authors");
  });

  it("mines a born-empty repository to a valid, empty history", () => {
    const empty = join(scratch, "empty-repo");
    mkdirSync(empty);
    execFileSync("git", ["init", "-q", "-b", "main", empty]);
    const out = join(scratch, "empty-history.jsonl");
    const io = captureIo();
    const code = runSync(["scm", empty, "--out", out], io);
    expect(code).toBe(EXIT.OK);
    const history = decodeHistoryText(io.files().get(out) ?? "");
    expect(history.commits).toEqual([]);
  });

  it("refuses a directory that is not a git repository (usage, exit 2)", () => {
    const plain = join(scratch, "not-a-repo");
    mkdirSync(plain);
    const { io, code } = invoke(["scm", plain]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("not a git repository");
    expect(io.stdout()).toBe("");
  });

  it("respects --since, dropping the older commits", () => {
    const out = join(scratch, "since.jsonl");
    const io = captureIo();
    const code = runSync(["scm", repo, "--since", "2024-01-02T00:00:00+00:00", "--out", out], io);
    expect(code).toBe(EXIT.OK);
    const history = decodeHistoryText(io.files().get(out) ?? "");
    expect(history.commits).toHaveLength(3);
  });

  it("--json reports the counts machine-readably", () => {
    const out = join(scratch, "json.jsonl");
    const io = captureIo();
    const code = runSync(["scm", repo, "--out", out, "--json"], io);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      repo: string;
      counts: Record<string, number>;
    };
    expect(parsed.repo).toBe("demo-repo");
    expect(parsed.counts).toEqual({ commits: 4, authors: 2, paths: 2, changes: 5 });
  });
});

describe("codegraph history reports hand-counted numbers", () => {
  it("summary: 4 commits, +7/-2, one fix (25.0%)", () => {
    const { io, code } = invoke(["history", historyPath]);
    expect(code).toBe(EXIT.OK);
    const text = io.stdout();
    expect(text).toContain("4 commits by 2 authors over 2 files");
    expect(text).toContain("2024-01-01 .. 2024-01-04 (3 days)");
    expect(text).toContain("+7 / -2 (9 lines)");
    expect(text).toContain("1 fixes (25.0% of commits), 0 reverts");
  });

  it("hotspots: the renamed lineage leads with 3 revisions and both authors", () => {
    const { io, code } = invoke(["history", historyPath, "--report", "hotspots", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { total: number; rows: Record<string, unknown>[] };
    expect(parsed.total).toBe(2);
    expect(parsed.rows[0]).toEqual({
      path: "src/two.txt",
      revisions: 3,
      added: 5,
      deleted: 0,
      churn: 5,
      fixes: 1,
      bugDensity: 1 / 3,
      authors: 2,
    });
    expect(parsed.rows[1]).toMatchObject({ path: "docs/readme.md", revisions: 2, churn: 4, authors: 1 });
  });

  it("authors: alice owns both lineages, bus factor 1", () => {
    const { io, code } = invoke(["history", historyPath, "--report", "authors", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { busFactor: number; rows: Record<string, unknown>[] };
    expect(parsed.busFactor).toBe(1);
    expect(parsed.rows[0]).toEqual({
      author: "Alice <alice@example.com>",
      commits: 2,
      added: 5,
      deleted: 2,
      churn: 7,
      paths: 2,
      fixes: 0,
      owns: 2,
    });
    expect(parsed.rows[1]).toMatchObject({ author: "Bob <bob@example.com>", fixes: 1, owns: 0 });
  });

  it("--top limits the hotspot rows but still names the total", () => {
    const { io, code } = invoke(["history", historyPath, "--report", "hotspots", "--top", "1"]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("top 1 of 2 files");
    expect(io.stdout()).not.toContain("docs/readme.md");
  });

  it("refuses a missing file as a usage error that says how to mine it", () => {
    const { io, code } = invoke(["history", join(scratch, "nowhere.jsonl")]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("codegraph scm");
  });

  it("--city writes the laid-out replay artifact: files as buildings, commits as ticks", () => {
    const out = join(scratch, "replay-city.json");
    const { io, code } = invoke(["history", historyPath, "--city", out]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe(""); // the artifact is the deliverable, not a report
    const city = JSON.parse(io.files().get(out) ?? "") as {
      kind: string;
      buildings: { id: string; position?: object }[];
      districts: { id: string }[];
      replay: { clock: string; ticks: unknown[]; series: Record<string, unknown> };
    };
    expect(city.kind).toBe("codegraph.city/1");
    expect(city.buildings.map((b) => b.id)).toEqual(["file:docs/readme.md", "file:src/two.txt"]);
    expect(city.buildings.every((b) => typeof b.position === "object")).toBe(true);
    expect(city.districts.map((d) => d.id)).toEqual(["dir:docs", "dir:src"]);
    expect(city.replay.clock).toBe("commits");
    expect(city.replay.ticks).toHaveLength(4);
    expect(Object.keys(city.replay.series).sort()).toEqual([
      "file:docs/readme.md",
      "file:src/two.txt",
    ]);
  });

  it("--serve hands the same artifact to the server seam", () => {
    const io = captureIo();
    const served: string[] = [];
    const deps: ServeDeps = {
      assetsDir: () => "/fake/assets",
      startServer: (serverOptions) => {
        served.push(serverOptions.artifact);
        return undefined;
      },
    };
    const code = historyCommand(
      {
        history: historyPath,
        report: "summary",
        top: undefined,
        model: undefined,
        minSupport: 3,
        minConfidence: 0.5,
        serve: true,
        port: 0,
        host: "127.0.0.1",
        city: undefined,
        json: false,
      },
      io,
      deps,
    );
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(served).toHaveLength(1);
    const artifact = JSON.parse(served[0] ?? "") as { replay?: { ticks: unknown[] } };
    expect(artifact.replay?.ticks).toHaveLength(4);
  });

  it("treats a readable non-history file as a finding (exit 3)", () => {
    const bogus = join(scratch, "bogus.jsonl");
    writeFileSync(bogus, '{"t":"header","schemaVersion":1}\n', "utf8");
    const { io, code } = invoke(["history", bogus]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("not a history.jsonl");
    expect(io.stdout()).toBe("");
  });
});
