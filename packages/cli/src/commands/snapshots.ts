import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { JsonlError, type Repository } from "@codegraph/core";
import {
  TemporalStoreError,
  diagnoseStore,
  importModelAt,
  isClean,
  listRevisions,
  openStore,
} from "@codegraph/analyzer";
import type { SnapshotsOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";
import { repositoryFacts } from "../repository.js";

/**
 * `codegraph snapshots [repo] --jar FILE (--every N | --tags) [--store FILE]`.
 *
 * THE M9b ORCHESTRATION (PLAN §11.2): for each sampled revision, check the
 * commit out into a throwaway `git worktree` — the user's checkout is never
 * mutated — run the Java extractor there, and append the result to the
 * temporal store exactly as `import --at <sha> --time <t>` would. Spoon runs
 * noClasspath, so historic commits that no longer compile still extract.
 *
 * RESUMABLE BY DESIGN. Every frame costs a full extraction (minutes on a real
 * corpus), so a revision the store already holds is skipped, never re-imported:
 * an interrupted run continues where it stopped, and a later run after new
 * commits imports only the new tip. The stride is recomputed from the CURRENT
 * history — the store's sha set, not frame numbering, is what resume keys on.
 *
 * FAILURE ISOLATION. One revision failing to extract is a statement about that
 * revision (a tree with no sources yet, an extractor crash), not about the
 * run: it is reported, counted, and the remaining frames still import. Only
 * invocation-level problems — no git, no java, an unreadable jar, a store
 * refusing revisions — abort, as usage errors.
 *
 * STREAMS (decision 3): stdout says what is true of the STORE (path, counts);
 * stderr narrates the run, one line per frame, durations included.
 */
export function snapshotsCommand(
  options: SnapshotsOptions,
  io: IoSink,
  extract: Extract = javaExtract(options.jar),
): ExitCode {
  requireReadableJar(options.jar);
  const repoName = basename(resolve(options.repo));
  const store = options.store ?? `${repoName}-model.db`;

  const git = gitRunner(options.repo);
  const frames = options.tags ? tagFrames(git) : strideFrames(git, options.every ?? 1);
  const held = existingShas(store);

  // Repository provenance (M10a): the remote is the repo's, the root is the
  // `--src` prefix already relative to it, and the commit is the FRAME's — a
  // permalink per revision is what makes a scrubbed link open the right tree.
  const remote = originRemote(git);
  const factsAt = (sha: string): Repository | undefined =>
    repositoryFacts(remote, sha, options.src);
  if (factsAt(frames[0]?.sha ?? "0".repeat(40)) === undefined) {
    errLine(
      io,
      `note: ${options.repo} has no https-projectable \`origin\` remote — the snapshots will ` +
        "carry no repository facts, so the city shows no source links.",
    );
  }

  const imported: ImportedFrame[] = [];
  const skipped: string[] = [];
  const failed: { sha: string; message: string }[] = [];
  let findings = 0;

  // One scratch root for the whole run; each frame gets its own worktree
  // and model file inside it, removed as soon as the frame is imported.
  const scratch = mkdtempSync(join(tmpdir(), "codegraph-snapshots-"));
  try {
    for (const [index, frame] of frames.entries()) {
      const tag = `[${index + 1}/${frames.length}] ${frame.sha.slice(0, 7)}${
        frame.label === undefined ? "" : ` (${frame.label})`
      }`;
      if (held.has(frame.sha)) {
        skipped.push(frame.sha);
        errLine(io, `${tag} skipped — already in the store`);
        continue;
      }

      const started = performance.now();
      let result: ImportedFrame;
      try {
        result = snapshotOne(git, frame, {
          scratch,
          store,
          src: options.src,
          extract,
          repository: factsAt(frame.sha),
        });
      } catch (error) {
        // Usage errors (no java, a store refusing revisions) abort the run;
        // anything else is this FRAME failing, and the loop continues.
        if (error instanceof UsageError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ sha: frame.sha, message });
        errLine(io, `${tag} FAILED — ${firstLine(message)}`);
        continue;
      }
      imported.push(result);
      findings += result.findings;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      errLine(
        io,
        `${tag} -> ${result.entities} entities, ${result.edges} edges in ${seconds} s` +
          (result.findings === 0 ? "" : ` (${result.findings} findings — see codegraph validate)`),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const revisions = existingShas(store).size;
  const ok = failed.length === 0 && findings === 0;
  outLines(
    io,
    options.json
      ? [renderJson({ repo: repoName, store, frames: frames.length, imported, skipped, failed, revisions, ok })]
      : renderText({ repo: options.repo, store, imported, skipped, failed, revisions }),
  );
  return ok ? EXIT.OK : EXIT.FINDINGS;
}

/**
 * The extractor seam: produce a model.jsonl for the tree at `srcDir`.
 * `repository` is the frame's provenance (M10a) — undefined when the repo has
 * no projectable remote, and the extraction then states no repository at all.
 */
export type Extract = (
  srcDir: string,
  modelPath: string,
  repository: Repository | undefined,
) => void;

interface Frame {
  readonly sha: string;
  /** Commit time, unix seconds — what timeline queries order by. */
  readonly time: number;
  /** The tag that selected this commit, when `--tags` did. */
  readonly label?: string | undefined;
}

interface ImportedFrame {
  readonly sha: string;
  readonly time: number;
  readonly entities: number;
  readonly edges: number;
  readonly findings: number;
}

/** One frame: worktree out, extract, append to the store, clean up. */
function snapshotOne(
  git: GitRunner,
  frame: Frame,
  ctx: {
    scratch: string;
    store: string;
    src: string | undefined;
    extract: Extract;
    repository: Repository | undefined;
  },
): ImportedFrame {
  const worktree = join(ctx.scratch, `wt-${frame.sha.slice(0, 12)}`);
  const model = join(ctx.scratch, `model-${frame.sha.slice(0, 12)}.jsonl`);
  git(["worktree", "add", "--detach", worktree, frame.sha]);
  try {
    const srcDir = ctx.src === undefined ? worktree : join(worktree, ctx.src);
    ctx.extract(srcDir, model, ctx.repository);
    return appendRevision(model, ctx.store, frame);
  } finally {
    rmSync(model, { force: true });
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      // The worktree directory may already be gone (a crashed extractor can
      // take it down); remove what remains and let git forget the registration.
      rmSync(worktree, { recursive: true, force: true });
      try {
        git(["worktree", "prune"]);
      } catch {
        /* pruning is best-effort — a stale registration is cosmetic */
      }
    }
  }
}

/** `import --at`, exactly: append, then diagnose what the store now mirrors. */
function appendRevision(model: string, store: string, frame: Frame): ImportedFrame {
  let result;
  try {
    result = importModelAt(model, store, { sha: frame.sha, time: frame.time });
  } catch (error) {
    // A store-level refusal (version mismatch) poisons every later frame the
    // same way: abort the run. The store is precious and was not changed.
    if (error instanceof TemporalStoreError) {
      throw new UsageError(error.message, "Temporal stores accumulate; nothing was changed.", {
        cause: error,
      });
    }
    // The extractor emitted something the record reader refuses: a statement
    // about this frame's extraction, handled by the caller like any failure.
    if (error instanceof JsonlError) throw new Error(`extractor output is not a model: ${error.message}`);
    throw error;
  }

  const db = openStore(result.path);
  try {
    const diagnostics = diagnoseStore(db, { label: `${frame.sha.slice(0, 7)}`, modelIndex: 0 });
    const findings = isClean(diagnostics)
      ? 0
      : diagnostics.profileIssues.length +
        diagnostics.selfEdges.length +
        diagnostics.duplicateIds.length +
        diagnostics.unknownProfiles.length;
    return {
      sha: frame.sha,
      time: frame.time,
      entities: result.counts.entities,
      edges: result.counts.edges,
      findings,
    };
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────── revision selection

type GitRunner = (args: readonly string[]) => string;

/** Verifies the invocation the way `scm` does, then returns the runner. */
function gitRunner(repo: string): GitRunner {
  const git: GitRunner = (args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });

  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new UsageError(
        "git is not installed or not on PATH",
        "codegraph snapshots checks revisions out with `git worktree`; install git and retry.",
        { cause: error },
      );
    }
    throw new UsageError(
      `${repo} is not a git repository`,
      "Point codegraph snapshots at a directory inside a git work tree.",
      { cause: error },
    );
  }

  try {
    git(["rev-parse", "--verify", "-q", "HEAD"]);
  } catch (error) {
    throw new UsageError(`${repo} has no commits — nothing to snapshot`, undefined, { cause: error });
  }
  return git;
}

/**
 * Every Nth first-parent commit, oldest first, the tip always included: the
 * newest code is the frame every timeline's `presentInLatest` answers against.
 */
function strideFrames(git: GitRunner, every: number): Frame[] {
  const all = git(["log", "--first-parent", "--reverse", "--format=%H %ct"])
    .split("\n")
    .filter((line) => line !== "")
    .map(parseFrameLine);
  const frames = all.filter((_, index) => index % every === 0);
  const tip = all[all.length - 1];
  if (tip !== undefined && frames[frames.length - 1]?.sha !== tip.sha) frames.push(tip);
  return frames;
}

/** The tagged commits (annotated tags peeled), deduplicated, oldest first. */
function tagFrames(git: GitRunner): Frame[] {
  const names = git(["tag", "--sort=creatordate"])
    .split("\n")
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new UsageError(
      "the repository has no tags",
      "Use --every N to sample first-parent commits instead.",
    );
  }
  const bySha = new Map<string, Frame>();
  for (const name of names) {
    const frame = parseFrameLine(git(["log", "-1", "--format=%H %ct", name]).trim());
    // Two tags on one commit are one keyframe; the older tag names it.
    if (!bySha.has(frame.sha)) bySha.set(frame.sha, { ...frame, label: name });
  }
  return [...bySha.values()].sort((a, b) => a.time - b.time || (a.sha < b.sha ? -1 : 1));
}

function parseFrameLine(line: string): Frame {
  const space = line.indexOf(" ");
  return { sha: line.slice(0, space), time: Number(line.slice(space + 1)) };
}

/** The shas the store already holds — resume keys on this, never on ordinals. */
function existingShas(store: string): Set<string> {
  if (!existsSync(store)) return new Set();
  try {
    const db = openStore(store);
    try {
      return new Set(listRevisions(db).map((revision) => revision.sha));
    } finally {
      db.close();
    }
  } catch {
    // Not readable as a temporal store: let importModelAt say why, precisely.
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────── the extractor

/**
 * `git remote get-url origin`, or undefined when there is no origin. A repo
 * with several remotes still has exactly one the analysis is "about", and
 * origin is that one by universal convention.
 */
function originRemote(git: GitRunner): string | undefined {
  try {
    const url = git(["remote", "get-url", "origin"]).trim();
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/** The real extractor: `java -jar <jar> --src <dir> --out <model>`. */
function javaExtract(jar: string): Extract {
  return (srcDir, modelPath, repository) => {
    const repoFlags =
      repository === undefined
        ? []
        : [
            "--repo-remote", repository.remote,
            "--repo-commit", repository.commit,
            "--repo-root", repository.root,
          ];
    try {
      execFileSync("java", ["-jar", jar, "--src", srcDir, "--out", modelPath, ...repoFlags], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1 << 28,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        throw new UsageError(
          "java is not installed or not on PATH",
          "codegraph snapshots runs the extractor with `java -jar`; install a JDK and retry.",
          { cause: error },
        );
      }
      // The jar spoke: keep its last words — they name the actual problem.
      const stderr = (error as { stderr?: string }).stderr;
      const said = typeof stderr === "string" ? lastLines(stderr, 3) : "";
      throw new Error(
        `extractor exited abnormally${said === "" ? "" : `:\n${said}`}`,
        { cause: error },
      );
    }
  };
}

function requireReadableJar(jar: string): void {
  try {
    accessSync(jar, constants.R_OK);
  } catch (error) {
    throw new UsageError(
      `cannot read the extractor jar at ${jar}`,
      "Build it first: cd extractors/java && ./mvnw package -> target/codegraph-java.jar",
      { cause: error },
    );
  }
}

// ─────────────────────────────────────────────────────────────── rendering

function renderText(summary: {
  repo: string;
  store: string;
  imported: readonly ImportedFrame[];
  skipped: readonly string[];
  failed: readonly { sha: string; message: string }[];
  revisions: number;
}): readonly string[] {
  const lines: string[] = [];
  lines.push(`snapshotted ${summary.repo} -> ${summary.store}`);
  lines.push(
    `  ${summary.imported.length} imported, ${summary.skipped.length} skipped, ` +
      `${summary.failed.length} failed`,
  );
  lines.push(`  the store holds ${summary.revisions} revision${summary.revisions === 1 ? "" : "s"}`);
  if (summary.failed.length > 0) {
    lines.push("");
    lines.push(`failed to extract (${summary.failed.length}):`);
    for (const one of summary.failed) lines.push(`  ${one.sha.slice(0, 7)}: ${firstLine(one.message)}`);
  }
  lines.push("");
  lines.push(
    summary.failed.length === 0
      ? "OK — walk an entity with `codegraph timeline <id> --store " + summary.store + "`."
      : "Rerun the same command to retry the failed revisions; imported ones are skipped.",
  );
  return lines;
}

function renderJson(summary: {
  repo: string;
  store: string;
  frames: number;
  imported: readonly ImportedFrame[];
  skipped: readonly string[];
  failed: readonly { sha: string; message: string }[];
  revisions: number;
  ok: boolean;
}): string {
  return JSON.stringify(
    {
      ok: summary.ok,
      repo: summary.repo,
      store: summary.store,
      selected: summary.frames,
      imported: summary.imported,
      skipped: summary.skipped,
      failed: summary.failed,
      revisions: summary.revisions,
    },
    null,
    2,
  );
}

function firstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut === -1 ? text : `${text.slice(0, cut)} …`;
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-n).join("\n");
}
