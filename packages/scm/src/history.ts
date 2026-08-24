/**
 * The in-memory evolution model — what a decoded `history.jsonl` IS.
 *
 * Evolution facts are a THIRD artifact (PLAN §11, principle 1): repo-scoped,
 * language-agnostic, and changing on every commit while structure does not.
 * They never merge into `model.jsonl` and never grow a provenance value; the
 * join with the code model happens in the analyzer, on paths.
 *
 * References are surrogate ints into the `authors`, `paths` and `commits`
 * arrays — the same M6 discipline as the model wire, kept in memory too
 * because every report joins on them and the arrays ARE the dictionaries.
 */

/** One commit, as the miner saw it: metadata only, no code intelligence. */
export interface Commit {
  /** The full commit hash — SCM-native identity, never abbreviated. */
  readonly hash: string;
  /** Index into {@link History.authors}. */
  readonly author: number;
  /** Committer timestamp, unix seconds — the replay's clock. */
  readonly time: number;
  /** Subject matched the fix heuristic (a LABELED heuristic, not a fact). */
  readonly isFix: boolean;
  /** Subject matched the revert heuristic. */
  readonly isRevert: boolean;
}

/** One file touched by one commit. */
export interface Change {
  /** Index into {@link History.commits}. */
  readonly commit: number;
  /**
   * Index into {@link History.paths} — the file's LINEAGE, not the literal
   * path at that commit: rename chains are resolved at mine time, so one
   * surrogate names one file across its renames (PLAN §11.1).
   */
  readonly path: number;
  /** Lines added; 0 for binary files (numstat reports `-`). */
  readonly added: number;
  /** Lines deleted; 0 for binary files. */
  readonly deleted: number;
  /** The literal pre-rename path, when this change renamed the file. */
  readonly renamedFrom?: string | undefined;
}

export interface History {
  readonly schemaVersion: number;
  /** The SCM mined (`git` today; the door stays open for hg/fossil). */
  readonly scm: string;
  /** Miner name+version, e.g. `codegraph-scm@0.1.0`. */
  readonly miner: string;
  /**
   * The repository's BASENAME, never its absolute path: the file must be
   * byte-identical wherever the same repo is mined (determinism is the DoD).
   */
  readonly repo: string;
  /** Sorted, distinct `Name <email>` strings. Identity is the email pair; `.mailmap` applies when the repo has one. */
  readonly authors: readonly string[];
  /** Sorted, distinct lineage paths — each file's most recent name. */
  readonly paths: readonly string[];
  /** Sorted by (time, hash) ascending — replay order. */
  readonly commits: readonly Commit[];
  /** Sorted by (commit, path) ascending. */
  readonly changes: readonly Change[];
}

export const HISTORY_SCHEMA_VERSION = 1;

/**
 * The fix/revert subject heuristics — exported so the label "heuristic" is
 * inspectable, not folklore. Conventional-commit `fix:`/`fix(scope):` and the
 * crime-scene vocabulary both count; `revert` only as the leading word.
 */
export const FIX_SUBJECT = /\b(fix(es|ed)?|bug|defect|hotfix|patch)\b/i;
export const REVERT_SUBJECT = /^revert\b/i;
