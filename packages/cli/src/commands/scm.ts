import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import {
  encodeHistoryToString,
  gitLogArgs,
  parseGitLog,
  summarize,
  type History,
} from "@codegraph/scm";
import type { ScmOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";
import { cliVersion } from "../version.js";

/**
 * `codegraph scm [repo] [--since DATE] [--out FILE] [--json]`.
 *
 * THE ONE SUBPROCESS in the CLI: one `git log` pass, parsed by the pure
 * `@codegraph/scm` parser — the miner has no code intelligence (PLAN §11,
 * principle 2), and everything smarter is derived downstream by `history`.
 *
 * STREAMS (decision 3). The artifact is the FILE, always: unlike a report
 * there is no stdout mode, because `history.jsonl` is an interchange to be
 * mined once and read many times. stdout says what is true of the artifact
 * (where it is, what it carries); stderr says what was true of the run.
 *
 * DETERMINISM is the M9a DoD: the encoder canonicalizes and the header
 * carries the repo's BASENAME, never its absolute path — mining the same
 * repo from anywhere yields byte-identical output.
 */
export function scmCommand(options: ScmOptions, io: IoSink): ExitCode {
  const repoName = basename(resolve(options.repo));
  const out = options.out ?? `${repoName}-history.jsonl`;

  const started = performance.now();
  const raw = mine(options.repo, options.since);
  // Bytes git emitted that the parser cannot read are a bug in the MINER, not
  // in the repository: GitLogParseError propagates and exits 1 ("a bug in
  // codegraph"), which is exactly what it is.
  const history: History = parseGitLog(raw, {
    repo: repoName,
    miner: `codegraph-scm@${cliVersion()}`,
  });
  io.writeFile(out, encodeHistoryToString(history));
  const elapsedMs = performance.now() - started;

  const summary = summarize(history);
  errLine(io, `${options.repo}: mined in ${(elapsedMs / 1000).toFixed(2)} s`);

  if (options.json) {
    outLines(io, [
      JSON.stringify(
        {
          repo: history.repo,
          out,
          counts: {
            commits: summary.commits,
            authors: summary.authors,
            paths: summary.paths,
            changes: history.changes.length,
          },
          span: summary.span ?? null,
        },
        null,
        2,
      ),
    ]);
  } else {
    outLines(io, [
      `mined ${options.repo} -> ${out}`,
      `  ${plural(summary.commits, "commit")} by ${plural(summary.authors, "author")}, ` +
        `${plural(summary.paths, "file lineage")}, ${plural(history.changes.length, "change")}` +
        (summary.span === undefined ? "" : `, ${day(summary.span.from)} .. ${day(summary.span.to)}`),
    ]);
  }
  return EXIT.OK;
}

/**
 * Runs git; maps the failures that are about the INVOCATION — no git, no
 * repository — to usage errors. A repository with no commits yet is neither:
 * it mines to a valid, empty history.
 */
function mine(repo: string, since: string | undefined): string {
  const git = (args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 30,
    });

  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new UsageError(
        "git is not installed or not on PATH",
        "codegraph scm shells out to `git log`; install git and retry.",
        { cause: error },
      );
    }
    throw new UsageError(
      `${repo} is not a git repository`,
      "Point codegraph scm at a directory inside a git work tree.",
      { cause: error },
    );
  }

  try {
    git(["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    return ""; // Born-empty repository: no commits is a valid history.
  }

  return git(gitLogArgs(since));
}

function day(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
