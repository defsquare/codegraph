import {
  FIX_SUBJECT,
  HISTORY_SCHEMA_VERSION,
  REVERT_SUBJECT,
  type Change,
  type Commit,
  type History,
} from "./history.js";

/**
 * The `git log` parser — pure: raw bytes in (as a string), {@link History}
 * out. The miner has NO code intelligence (PLAN §11, principle 2): paths,
 * authors, timestamps and line deltas from one log pass; everything smarter
 * is derived downstream.
 *
 * The CLI owns the subprocess; this module owns the exact invocation so the
 * parser and the process it parses can never drift apart.
 */

/**
 * `\x01`-delimited commit header, `\x01`-terminated so the numstat block that
 * follows is separable. `%aN <%aE>` honors `.mailmap` when the repo has one;
 * `%ct` (committer time) is the replay's clock. A subject containing `\x01`
 * would corrupt the frame — and cannot be written from any terminal.
 */
export const GIT_PRETTY = "format:\x01%H\x01%aN <%aE>\x01%ct\x01%s\x01";

/**
 * `-z` matters twice: numstat paths come through UNQUOTED (no C-escaping to
 * undo), and a rename becomes `A<TAB>D<TAB>` + NUL + oldpath + NUL + newpath —
 * machine-parseable where the `{old => new}` brace form is not.
 */
export function gitLogArgs(since?: string): string[] {
  const args = ["log", "--no-merges", "--find-renames", "--numstat", "-z", `--pretty=${GIT_PRETTY}`];
  if (since !== undefined) args.push(`--since=${since}`);
  return args;
}

export interface MineMeta {
  /** Repo BASENAME — never an absolute path (byte-determinism, PLAN §11.1 DoD). */
  readonly repo: string;
  /** Miner name+version, e.g. `codegraph-scm@0.1.0`. */
  readonly miner: string;
}

export class GitLogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLogParseError";
  }
}

interface RawChange {
  readonly commit: number;
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  readonly renamedFrom?: string | undefined;
}

interface RawCommit {
  readonly hash: string;
  readonly author: string;
  readonly time: number;
  readonly isFix: boolean;
  readonly isRevert: boolean;
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/** `-` means binary: git counted no lines, so neither do we (documented). */
function lines(field: string): number {
  return field === "-" ? 0 : Number(field);
}

/**
 * Raw `git log` output (the {@link gitLogArgs} invocation, newest commit
 * first) → canonical {@link History}: rename chains resolved so one path
 * surrogate names one file lineage, dictionaries sorted, commits in
 * (time, hash) order, changes in (commit, path) order.
 */
export function parseGitLog(raw: string, meta: MineMeta): History {
  const commits: RawCommit[] = [];
  const raws: RawChange[] = [];

  const tokens = raw.split("\0");
  let current = -1;

  const startCommit = (hash: string, author: string, time: string, subject: string): void => {
    if (!/^[0-9a-f]{40,64}$/.test(hash)) {
      throw new GitLogParseError(`malformed commit hash ${JSON.stringify(hash)} — is this git log output?`);
    }
    const seconds = Number(time);
    if (!Number.isInteger(seconds)) {
      throw new GitLogParseError(`malformed timestamp ${JSON.stringify(time)} for commit ${hash}`);
    }
    commits.push({
      hash,
      author,
      time: seconds,
      isFix: FIX_SUBJECT.test(subject),
      isRevert: REVERT_SUBJECT.test(subject),
    });
    current = commits.length - 1;
  };

  // Consumes `\x01hash\x01author\x01ts\x01subject\x01` off the front, looping
  // because a commit with no changes runs straight into the next header.
  const parseHeaders = (token: string): string => {
    let rest = token;
    while (rest.startsWith("\x01")) {
      const fields: string[] = [];
      let at = 1;
      for (let field = 0; field < 4; field += 1) {
        const end = rest.indexOf("\x01", at);
        if (end === -1) throw new GitLogParseError("truncated commit header — is this git log output?");
        fields.push(rest.slice(at, end));
        at = end + 1;
      }
      startCommit(fields[0] as string, fields[1] as string, fields[2] as string, fields[3] as string);
      rest = rest.slice(at);
      if (rest.startsWith("\n")) rest = rest.slice(1);
    }
    return rest;
  };

  for (let at = 0; at < tokens.length; at += 1) {
    let token = tokens[at] as string;
    if (token.startsWith("\x01")) token = parseHeaders(token);
    if (token === "") continue;

    const entry = NUMSTAT.exec(token);
    if (entry === null) {
      throw new GitLogParseError(`unrecognized numstat entry ${JSON.stringify(token.slice(0, 80))}`);
    }
    if (current === -1) throw new GitLogParseError("numstat entry before any commit header");
    const added = lines(entry[1] as string);
    const deleted = lines(entry[2] as string);
    const path = entry[3] as string;
    if (path === "") {
      // A rename: the path field is empty and the two NUL-separated tokens
      // that follow carry the old and new paths.
      const from = tokens[at + 1];
      const to = tokens[at + 2];
      if (from === undefined || to === undefined || from === "" || to === "") {
        throw new GitLogParseError(`truncated rename entry after commit ${commits[current]?.hash}`);
      }
      at += 2;
      raws.push({ commit: current, path: to, added, deleted, renamedFrom: from });
    } else {
      raws.push({ commit: current, path, added, deleted });
    }
  }

  return canonicalize(commits, resolveLineages(raws), meta);
}

/**
 * Rename-chain resolution (PLAN §11.1): walking NEWEST → OLDEST — the order
 * git emits — every path is mapped to the most recent name of its lineage,
 * and a rename extends that mapping to the pre-rename path for all older
 * commits. A path reused after a deletion therefore MERGES into the reusing
 * file's lineage: lineages are named by paths, and two lineages cannot share
 * a name. Documented approximation, not an accident.
 */
function resolveLineages(raws: readonly RawChange[]): RawChange[] {
  const lineage = new Map<string, string>();
  const resolve = (path: string): string => {
    const found = lineage.get(path);
    if (found !== undefined) return found;
    lineage.set(path, path);
    return path;
  };
  return raws.map((raw) => {
    const target = resolve(raw.path);
    if (raw.renamedFrom !== undefined) lineage.set(raw.renamedFrom, target);
    return target === raw.path ? raw : { ...raw, path: target };
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted dictionaries, (time, hash) commits, (commit, path) changes. */
function canonicalize(
  rawCommits: readonly RawCommit[],
  rawChanges: readonly RawChange[],
  meta: MineMeta,
): History {
  const authors = [...new Set(rawCommits.map((commit) => commit.author))].sort(compareText);
  const authorRef = new Map(authors.map((author, index) => [author, index]));
  const paths = [...new Set(rawChanges.map((change) => change.path))].sort(compareText);
  const pathRef = new Map(paths.map((path, index) => [path, index]));

  const order = rawCommits
    .map((commit, index) => ({ commit, index }))
    .sort((a, b) => a.commit.time - b.commit.time || compareText(a.commit.hash, b.commit.hash));
  const commitRef = new Map(order.map(({ index }, at) => [index, at]));

  const commits: Commit[] = order.map(({ commit }) => ({
    hash: commit.hash,
    author: authorRef.get(commit.author) as number,
    time: commit.time,
    isFix: commit.isFix,
    isRevert: commit.isRevert,
  }));

  // Lineage merging can land two raw changes on one (commit, path): sum the
  // deltas, keep the first rename provenance — one change per file per commit.
  const merged = new Map<string, { commit: number; path: number; added: number; deleted: number; renamedFrom?: string | undefined }>();
  for (const raw of rawChanges) {
    const commit = commitRef.get(raw.commit) as number;
    const path = pathRef.get(raw.path) as number;
    const key = `${commit}:${path}`;
    const found = merged.get(key);
    if (found === undefined) {
      merged.set(key, {
        commit,
        path,
        added: raw.added,
        deleted: raw.deleted,
        ...(raw.renamedFrom === undefined ? {} : { renamedFrom: raw.renamedFrom }),
      });
    } else {
      found.added += raw.added;
      found.deleted += raw.deleted;
      if (found.renamedFrom === undefined && raw.renamedFrom !== undefined) {
        found.renamedFrom = raw.renamedFrom;
      }
    }
  }
  const changes: Change[] = [...merged.values()].sort(
    (a, b) => a.commit - b.commit || a.path - b.path,
  );

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    scm: "git",
    miner: meta.miner,
    repo: meta.repo,
    authors,
    paths,
    commits,
    changes,
  };
}
