import type { History } from "./history.js";

/**
 * The file-level evolution reports (PLAN §11.1) — pure functions over a
 * {@link History}, no model join yet: that is M9b's cross-graph work. Every
 * number here is derivable from `git log` alone, and every ranking is
 * deterministically tie-broken so the reports are byte-stable.
 */

const DAY = 86_400;
/** The recency window momentum and firefighting are judged over. */
export const MOMENTUM_WINDOW_DAYS = 90;

export interface HistorySummary {
  readonly repo: string;
  readonly commits: number;
  readonly authors: number;
  readonly paths: number;
  /** Unix seconds of the first and last commit; undefined on an empty history. */
  readonly span: { readonly from: number; readonly to: number } | undefined;
  readonly added: number;
  readonly deleted: number;
  /** added + deleted — the crime-scene churn total. */
  readonly churn: number;
  readonly fixes: number;
  readonly reverts: number;
  /** Share of all commits that are fixes (0..1). */
  readonly firefighting: number;
  /**
   * Commit rate over the last {@link MOMENTUM_WINDOW_DAYS} days relative to
   * the lifetime rate; 1 = steady, >1 = accelerating. Judged against the LAST
   * commit, never the wall clock — the report of a file must not change
   * because a week passed. 1 when the history is younger than the window.
   */
  readonly momentum: number;
}

export function summarize(history: History): HistorySummary {
  const commits = history.commits;
  const first = commits[0];
  const last = commits[commits.length - 1];
  let added = 0;
  let deleted = 0;
  for (const change of history.changes) {
    added += change.added;
    deleted += change.deleted;
  }
  const fixes = commits.filter((commit) => commit.isFix).length;
  const reverts = commits.filter((commit) => commit.isRevert).length;

  let momentum = 1;
  if (first !== undefined && last !== undefined) {
    const spanDays = (last.time - first.time) / DAY;
    if (spanDays > MOMENTUM_WINDOW_DAYS) {
      const cutoff = last.time - MOMENTUM_WINDOW_DAYS * DAY;
      const recent = commits.filter((commit) => commit.time > cutoff).length;
      const lifetimeRate = commits.length / spanDays;
      momentum = recent / MOMENTUM_WINDOW_DAYS / lifetimeRate;
    }
  }

  return {
    repo: history.repo,
    commits: commits.length,
    authors: history.authors.length,
    paths: history.paths.length,
    span: first === undefined || last === undefined ? undefined : { from: first.time, to: last.time },
    added,
    deleted,
    churn: added + deleted,
    fixes,
    reverts,
    firefighting: commits.length === 0 ? 0 : fixes / commits.length,
    momentum,
  };
}

export interface HotspotRow {
  readonly path: string;
  /** Commits touching this lineage. */
  readonly revisions: number;
  readonly added: number;
  readonly deleted: number;
  readonly churn: number;
  /** Revisions that were fix commits. */
  readonly fixes: number;
  /** fixes / revisions — the labeled bug-density heuristic. */
  readonly bugDensity: number;
  /** Distinct authors that touched it. */
  readonly authors: number;
}

/** Ranked by revisions, then churn, then path — change frequency IS the hotspot signal. */
export function hotspots(history: History): HotspotRow[] {
  const rows = history.paths.map((path) => ({
    path,
    revisions: 0,
    added: 0,
    deleted: 0,
    fixes: 0,
    authors: new Set<number>(),
  }));
  for (const change of history.changes) {
    const row = rows[change.path];
    const commit = history.commits[change.commit];
    if (row === undefined || commit === undefined) continue;
    row.revisions += 1;
    row.added += change.added;
    row.deleted += change.deleted;
    if (commit.isFix) row.fixes += 1;
    row.authors.add(commit.author);
  }
  return rows
    .map((row) => ({
      path: row.path,
      revisions: row.revisions,
      added: row.added,
      deleted: row.deleted,
      churn: row.added + row.deleted,
      fixes: row.fixes,
      bugDensity: row.revisions === 0 ? 0 : row.fixes / row.revisions,
      authors: row.authors.size,
    }))
    .sort(
      (a, b) =>
        b.revisions - a.revisions ||
        b.churn - a.churn ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
}

export interface CouplingOptions {
  /** Pairs must co-change in at least this many commits. */
  readonly minSupport?: number;
  /** support / min(revisionsA, revisionsB) must reach this (0..1). */
  readonly minConfidence?: number;
  /**
   * Commits touching more than this many lineages are skipped: a sweeping
   * rename or a format-everything commit couples nothing meaningfully, and
   * one 300-file commit would mint 44 850 pairs.
   */
  readonly maxChangesetSize?: number;
}

export const COUPLING_DEFAULTS = {
  minSupport: 3,
  minConfidence: 0.5,
  maxChangesetSize: 30,
} as const;

export interface CoChangeRow {
  /** Lineage paths, `a` < `b` — the pair is unordered. */
  readonly a: string;
  readonly b: string;
  /** Commits that touched both. */
  readonly support: number;
  /** support / min(revisions of a, revisions of b). */
  readonly confidence: number;
  readonly revisionsA: number;
  readonly revisionsB: number;
}

export interface CoChangeReport {
  /** Ranked by support, then confidence, then (a, b). */
  readonly rows: readonly CoChangeRow[];
  /** Commits dropped by `maxChangesetSize` — stated, never silent. */
  readonly skippedChangesets: number;
}

/**
 * Logical coupling (Tornhill): files that change together, whatever the
 * declared graph says. Pure history — the cross-graph joins (hidden coupling,
 * dead weight) feed on these rows downstream.
 */
export function logicalCoupling(history: History, options: CouplingOptions = {}): CoChangeReport {
  const minSupport = options.minSupport ?? COUPLING_DEFAULTS.minSupport;
  const minConfidence = options.minConfidence ?? COUPLING_DEFAULTS.minConfidence;
  const maxChangesetSize = options.maxChangesetSize ?? COUPLING_DEFAULTS.maxChangesetSize;

  // Changes arrive sorted by (commit, path) — the decoder's contract — so a
  // commit's changeset is one contiguous run.
  const revisions = history.paths.map(() => 0);
  const changesets: number[][] = history.commits.map(() => []);
  for (const change of history.changes) {
    revisions[change.path] = (revisions[change.path] ?? 0) + 1;
    changesets[change.commit]?.push(change.path);
  }

  const support = new Map<number, number>();
  let skipped = 0;
  const width = history.paths.length;
  for (const changeset of changesets) {
    if (changeset.length > maxChangesetSize) {
      skipped += 1;
      continue;
    }
    for (let i = 0; i < changeset.length; i += 1) {
      for (let j = i + 1; j < changeset.length; j += 1) {
        const key = (changeset[i] as number) * width + (changeset[j] as number);
        support.set(key, (support.get(key) ?? 0) + 1);
      }
    }
  }

  const rows: CoChangeRow[] = [];
  for (const [key, count] of support) {
    if (count < minSupport) continue;
    const a = Math.floor(key / width);
    const b = key % width;
    const revisionsA = revisions[a] ?? 0;
    const revisionsB = revisions[b] ?? 0;
    const confidence = count / Math.max(1, Math.min(revisionsA, revisionsB));
    if (confidence < minConfidence) continue;
    rows.push({
      a: history.paths[a] as string,
      b: history.paths[b] as string,
      support: count,
      confidence,
      revisionsA,
      revisionsB,
    });
  }
  rows.sort(
    (x, y) =>
      y.support - x.support ||
      y.confidence - x.confidence ||
      (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
      (x.b < y.b ? -1 : x.b > y.b ? 1 : 0),
  );
  return { rows, skippedChangesets: skipped };
}

export interface FileOwner {
  /** `Name <email>`, exactly as the history's author table carries it. */
  readonly name: string;
  /** The owner's added lines over ALL added lines on the lineage (0..1]. */
  readonly share: number;
}

/**
 * Dominant author per lineage — the SAME rule `authorStats`' `owns` and the
 * bus factor use: most lines added, ties to the lexicographically first
 * author. A lineage nobody added lines to has no owner and is absent.
 */
export function fileOwners(history: History): ReadonlyMap<string, FileOwner> {
  const addedBy = history.paths.map(() => new Map<number, number>());
  for (const change of history.changes) {
    const commit = history.commits[change.commit];
    const perAuthor = addedBy[change.path];
    if (commit === undefined || perAuthor === undefined) continue;
    perAuthor.set(commit.author, (perAuthor.get(commit.author) ?? 0) + change.added);
  }

  const owners = new Map<string, FileOwner>();
  addedBy.forEach((perAuthor, path) => {
    let owner: number | undefined;
    let best = -1;
    let total = 0;
    for (const [author, added] of perAuthor) {
      total += added;
      if (added > best || (added === best && owner !== undefined && author < owner)) {
        owner = author;
        best = added;
      }
    }
    const name = owner === undefined ? undefined : history.authors[owner];
    if (name === undefined || total <= 0 || best <= 0) return;
    owners.set(history.paths[path] as string, { name, share: best / total });
  });
  return owners;
}

export interface AuthorRow {
  readonly author: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
  readonly churn: number;
  /** Distinct file lineages touched. */
  readonly paths: number;
  readonly fixes: number;
  /** File lineages this author OWNS (wrote the most lines of). */
  readonly owns: number;
}

export interface AuthorsReport {
  /** Ranked by commits, then churn, then name. */
  readonly rows: readonly AuthorRow[];
  /**
   * Truck/bus factor, file-granular v1: the smallest set of owners that
   * together own more than half of all file lineages. Ownership = most lines
   * added (ties to the lexicographically first author — deterministic).
   */
  readonly busFactor: number;
}

export function authorStats(history: History): AuthorsReport {
  const rows = history.authors.map((author) => ({
    author,
    commits: 0,
    added: 0,
    deleted: 0,
    fixes: 0,
    paths: new Set<number>(),
    owns: 0,
  }));
  for (const commit of history.commits) {
    const row = rows[commit.author];
    if (row === undefined) continue;
    row.commits += 1;
    if (commit.isFix) row.fixes += 1;
  }
  // added lines per (path, author) — the ownership evidence.
  const addedBy = history.paths.map(() => new Map<number, number>());
  for (const change of history.changes) {
    const commit = history.commits[change.commit];
    const row = commit === undefined ? undefined : rows[commit.author];
    if (commit === undefined || row === undefined) continue;
    row.added += change.added;
    row.deleted += change.deleted;
    row.paths.add(change.path);
    const perAuthor = addedBy[change.path];
    if (perAuthor !== undefined) {
      perAuthor.set(commit.author, (perAuthor.get(commit.author) ?? 0) + change.added);
    }
  }

  for (const perAuthor of addedBy) {
    let owner: number | undefined;
    let best = -1;
    for (const [author, added] of perAuthor) {
      if (added > best || (added === best && owner !== undefined && author < owner)) {
        owner = author;
        best = added;
      }
    }
    const row = owner === undefined ? undefined : rows[owner];
    if (row !== undefined) row.owns += 1;
  }

  const owned = rows
    .map((row) => row.owns)
    .filter((owns) => owns > 0)
    .sort((a, b) => b - a);
  let busFactor = 0;
  let covered = 0;
  for (const owns of owned) {
    if (covered * 2 > history.paths.length) break;
    covered += owns;
    busFactor += 1;
  }

  return {
    rows: rows
      .map((row) => ({
        author: row.author,
        commits: row.commits,
        added: row.added,
        deleted: row.deleted,
        churn: row.added + row.deleted,
        paths: row.paths.size,
        fixes: row.fixes,
        owns: row.owns,
      }))
      .sort(
        (a, b) =>
          b.commits - a.commits ||
          b.churn - a.churn ||
          (a.author < b.author ? -1 : a.author > b.author ? 1 : 0),
      ),
    busFactor,
  };
}
