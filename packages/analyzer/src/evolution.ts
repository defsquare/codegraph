import type { Edge, Entity, SourceAnchor } from "@codegraph/core";
import type { CodeGraph } from "./graph.js";
import { sortIds } from "./order.js";
import { stronglyConnectedComponents } from "./scc.js";

/**
 * THE CROSS-GRAPH QUERIES (M9b, PLAN §11.2) — the ones only a tool holding
 * BOTH graphs can ask. The evolution side arrives as DATA (co-change pairs
 * and paths mined by `@codegraph/scm`); the analyzer contributes the declared
 * graph. The two never import each other — the CLI is the join point, exactly
 * as it is for the file-level city.
 *
 * THE JOIN IS ON PATHS (PLAN §11, principle 1): `anchor.file` on the model
 * side, lineage paths on the history side. The two roots differ — a model is
 * extracted from `src/main/java`, a history is mined from the repo root — so
 * the join matches by SUFFIX: history path `src/main/java/com/A.java` joins
 * model path `com/A.java`. A suffix claimed by two lineages joins neither
 * and is counted, never guessed.
 */

/** One co-changed file pair, as `@codegraph/scm`'s logicalCoupling reports it. */
export interface CoChangedPair {
  readonly a: string;
  readonly b: string;
  readonly support: number;
  readonly confidence: number;
}

export interface FileJoin {
  /** history path → model path. */
  readonly modelOf: ReadonlyMap<string, string>;
  /** model path → history path — the same join, read backward. */
  readonly historyOf: ReadonlyMap<string, string>;
  /** History paths whose suffix matched two model files, or two history
   * paths claiming one model file. Joined to nothing, counted here. */
  readonly ambiguous: readonly string[];
}

/** Suffix-join history lineage paths onto the model's file table. */
export function joinOnPaths(
  modelFiles: Iterable<string>,
  historyPaths: Iterable<string>,
): FileJoin {
  const models = new Set(modelFiles);
  const modelOf = new Map<string, string>();
  const historyOf = new Map<string, string>();
  const ambiguous: string[] = [];

  for (const historyPath of historyPaths) {
    // Candidate model paths are the suffixes of the history path at segment
    // boundaries; testing each against the set is O(depth), no scan.
    let match: string | undefined;
    let doubled = false;
    for (let at = 0; at >= 0; at = historyPath.indexOf("/", at + 1)) {
      const suffix = at === 0 ? historyPath : historyPath.slice(at + 1);
      if (!models.has(suffix)) continue;
      if (match !== undefined) doubled = true;
      match = suffix;
    }
    if (match === undefined) continue;
    if (doubled) {
      ambiguous.push(historyPath);
      continue;
    }
    const previous = historyOf.get(match);
    if (previous !== undefined) {
      // Two lineages claim one model file: withdraw the first join too.
      modelOf.delete(previous);
      historyOf.delete(match);
      ambiguous.push(previous, historyPath);
      continue;
    }
    modelOf.set(historyPath, match);
    historyOf.set(match, historyPath);
  }

  return { modelOf, historyOf, ambiguous: ambiguous.sort() };
}

export interface FileDependencies {
  /** Every file that anchors an entity or an edge site — the join's domain. */
  readonly files: ReadonlySet<string>;
  /** Directed: file of the edge site → file declaring the target. */
  readonly out: ReadonlyMap<string, ReadonlySet<string>>;
  /** The same pairs with their edge counts, sorted (from, to). */
  readonly edges: readonly { readonly from: string; readonly to: string; readonly count: number }[];
}

/**
 * The declared graph, folded to FILES: an edge written in file A against an
 * entity declared in file B is a dependency of A on B. `declared` provenance
 * only by default — dead weight asks about FACTS, and a derived edge that
 * never co-changes indicts the inference, not the design.
 */
export function fileDependencies(
  graph: CodeGraph,
  options: { readonly declaredOnly?: boolean } = {},
): FileDependencies {
  const declaredOnly = options.declaredOnly ?? true;
  const files = new Set<string>();
  const out = new Map<string, Set<string>>();
  const counts = new Map<string, number>();

  const fileOf = (anchor: SourceAnchor | undefined): string | undefined => anchor?.file;
  for (const entity of graph.entities.values()) {
    const file = fileOf((entity as { anchor?: SourceAnchor }).anchor);
    if (file !== undefined) files.add(file);
  }

  for (const edge of graph.edges as readonly Edge[]) {
    if (declaredOnly && edge.provenance !== "declared") continue;
    const from = edge.anchor.file;
    const to = fileOf((graph.entity(edge.to) as { anchor?: SourceAnchor } | undefined)?.anchor);
    if (to === undefined || from === to) continue;
    files.add(from);
    let targets = out.get(from);
    if (targets === undefined) out.set(from, (targets = new Set()));
    targets.add(to);
    // A JSON array as the map key: paths are free text, so no separator
    // byte is safe — the encoder's own quoting is.
    const key = JSON.stringify([from, to]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const edges = [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = JSON.parse(key) as [string, string];
      return { from, to, count };
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  return { files, out, edges };
}

/** Directed reachability over the file graph — BFS, no allocation drama at file counts. */
function reaches(deps: FileDependencies, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let at = 0; at < queue.length; at += 1) {
    for (const next of deps.out.get(queue[at] as string) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export interface HiddenCouplingRow {
  /** History lineage paths, as mined. */
  readonly a: string;
  readonly b: string;
  /** The model files they joined to — the pair the graph knows nothing about. */
  readonly modelA: string;
  readonly modelB: string;
  readonly support: number;
  readonly confidence: number;
}

export interface HiddenCouplingReport {
  /** Ranked like the coupling rows they came from. */
  readonly rows: readonly HiddenCouplingRow[];
  /** Co-changed pairs where a side never joined a model file (docs, config…). */
  readonly outsideModel: number;
}

/**
 * HIDDEN COUPLING: pairs that change together with NO PATH between them in
 * the declared graph — in either direction, transitively. Files that depend
 * through a chain co-change legitimately; what survives here is coupling the
 * architecture does not explain.
 */
export function hiddenCoupling(
  pairs: readonly CoChangedPair[],
  deps: FileDependencies,
  join: FileJoin,
): HiddenCouplingReport {
  const rows: HiddenCouplingRow[] = [];
  let outsideModel = 0;
  for (const pair of pairs) {
    const modelA = join.modelOf.get(pair.a);
    const modelB = join.modelOf.get(pair.b);
    if (modelA === undefined || modelB === undefined) {
      outsideModel += 1;
      continue;
    }
    if (reaches(deps, modelA, modelB) || reaches(deps, modelB, modelA)) continue;
    rows.push({ a: pair.a, b: pair.b, modelA, modelB, support: pair.support, confidence: pair.confidence });
  }
  return { rows, outsideModel };
}

export interface DeadWeightRow {
  /** Model paths — the declared dependency that history never exercised. */
  readonly from: string;
  readonly to: string;
  /** Declared base edges folded into this file pair. */
  readonly edges: number;
  readonly revisionsFrom: number;
  readonly revisionsTo: number;
}

export interface DeadWeightReport {
  /** Ranked by edge count, then (from, to). */
  readonly rows: readonly DeadWeightRow[];
  /** Declared file pairs with an unjoined side — history cannot judge them. */
  readonly outsideHistory: number;
}

/**
 * DEAD WEIGHT: declared file dependencies that NEVER co-change. `support`
 * comes from the unthresholded pair counts (`logicalCoupling` with
 * minSupport 1, minConfidence 0); a pair the miner skipped for changeset
 * size still counts as co-changed there. Both sides' revision counts ride
 * along — a dependency on a file nobody has touched proves nothing yet.
 */
export function deadWeight(
  deps: FileDependencies,
  join: FileJoin,
  coChanged: readonly CoChangedPair[],
  revisionsByPath: ReadonlyMap<string, number>,
): DeadWeightReport {
  const supportOf = new Set<string>();
  for (const pair of coChanged) {
    supportOf.add(JSON.stringify(pair.a < pair.b ? [pair.a, pair.b] : [pair.b, pair.a]));
  }

  const rows: DeadWeightRow[] = [];
  let outsideHistory = 0;
  for (const edge of deps.edges) {
    const historyFrom = join.historyOf.get(edge.from);
    const historyTo = join.historyOf.get(edge.to);
    if (historyFrom === undefined || historyTo === undefined) {
      outsideHistory += 1;
      continue;
    }
    const key = JSON.stringify(
      historyFrom < historyTo ? [historyFrom, historyTo] : [historyTo, historyFrom],
    );
    if (supportOf.has(key)) continue;
    rows.push({
      from: edge.from,
      to: edge.to,
      edges: edge.count,
      revisionsFrom: revisionsByPath.get(historyFrom) ?? 0,
      revisionsTo: revisionsByPath.get(historyTo) ?? 0,
    });
  }
  rows.sort(
    (a, b) =>
      b.edges - a.edges ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  return { rows, outsideHistory };
}

/**
 * What the model measures in ONE FILE — the complexity side of a hotspot
 * (M23b, PLAN §24.5). `undefined` is "nothing in this file carries the key",
 * never zero: a file of constants has no cyclomatic complexity to report, and
 * a ranking must not read that as "simple".
 */
export interface FileMeasure {
  /** Source lines: the outermost measured entities written in the file. */
  readonly sloc: number | undefined;
  /** `cyclomatic` summed over every entity written in the file. */
  readonly cyclomatic: number | undefined;
  /** Files in this file's dependency cycle, itself included; 0 when it is in none. */
  readonly cycle: number;
}

function measured(entity: Entity, key: string): number | undefined {
  const value = (entity as { metrics?: Record<string, unknown> }).metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One measure per file of `deps.files`.
 *
 * LINES ARE COUNTED ONCE. A class's `sloc` already holds its methods' and its
 * nested classes'; a TypeScript module's holds everything in the file. So a
 * file's lines are those of the entities with NO measured ancestor in the same
 * file — the same-file clause is for a type written across several files,
 * whose members elsewhere have no outer entity where they stand.
 *
 * CYCLOMATIC IS SUMMED, because each operation carries its own branches and a
 * lambda's are charged to the lambda: the sum the city draws as a height.
 *
 * THE CYCLE is a strongly connected component of the FILE graph `deps` holds:
 * declared facts by default, so "this file is in a cycle" is one too.
 */
export function fileMeasures(graph: CodeGraph, deps: FileDependencies): ReadonlyMap<string, FileMeasure> {
  const sloc = new Map<string, number>();
  const cyclomatic = new Map<string, number>();

  const anchorFile = (entity: Entity | undefined): string | undefined =>
    (entity as { anchor?: SourceAnchor } | undefined)?.anchor?.file;
  const insideMeasured = (id: string, file: string): boolean => {
    const seen = new Set<string>();
    for (let at = graph.parentOf(id); at !== undefined && !seen.has(at); at = graph.parentOf(at)) {
      seen.add(at);
      const above = graph.entity(at);
      if (above !== undefined && anchorFile(above) === file && measured(above, "sloc") !== undefined) return true;
    }
    return false;
  };

  for (const entity of graph.entities.values()) {
    const file = anchorFile(entity);
    if (file === undefined) continue;
    const branches = measured(entity, "cyclomatic");
    if (branches !== undefined) cyclomatic.set(file, (cyclomatic.get(file) ?? 0) + branches);
    const lines = measured(entity, "sloc");
    if (lines !== undefined && !insideMeasured(entity.id, file)) sloc.set(file, (sloc.get(file) ?? 0) + lines);
  }

  const files = sortIds(deps.files);
  const cycle = new Map<string, number>();
  for (const component of stronglyConnectedComponents(files, (file) => [...(deps.out.get(file) ?? [])])) {
    if (component.length < 2) continue;
    for (const file of component) cycle.set(file, component.length);
  }

  return new Map(
    files.map((file) => [file, { sloc: sloc.get(file), cyclomatic: cyclomatic.get(file), cycle: cycle.get(file) ?? 0 }] as const),
  );
}

/**
 * The four ways the discovery walk ranks a hotspot (docs: discover/activity):
 * effort times one kind of trouble each.
 *
 *   classic   revisions x source lines
 *   branchy   revisions x cyclomatic complexity
 *   tangled   revisions, for a file locked in a dependency cycle
 *   fragile   revisions x fix density — which is the number of fixes
 */
export const HOTSPOT_FAMILIES = ["classic", "branchy", "tangled", "fragile"] as const;
export type HotspotFamily = (typeof HOTSPOT_FAMILIES)[number];
export const DEFAULT_HOTSPOT_FAMILY: HotspotFamily = "branchy";

/** One file's activity, as `@codegraph/scm`'s `hotspots` reports it. */
export interface FileActivity {
  readonly path: string;
  readonly revisions: number;
  readonly churn: number;
  readonly fixes: number;
  readonly bugDensity: number;
  readonly authors: number;
}

/** The model's side of a joined row, added to whatever the history side carried. */
export interface JoinedHotspotMeasures {
  /** The model file the history path joined to. */
  readonly model: string;
  /** `null`, not 0, when the model measured nothing of that kind in the file. */
  readonly sloc: number | null;
  readonly cyclomatic: number | null;
  readonly cycle: number;
  readonly scores: Readonly<Record<HotspotFamily, number>>;
  /** 1-based position in each family; `null` where the score is 0. */
  readonly ranks: Readonly<Record<HotspotFamily, number | null>>;
}

/** The history's row, whole — a caller's extra fields ride along — plus the model's side. */
export type JoinedHotspotRow<A extends FileActivity = FileActivity> = A & JoinedHotspotMeasures;

export interface JoinedHotspotReport<A extends FileActivity = FileActivity> {
  /** The family `rows` is ordered by. */
  readonly rank: HotspotFamily;
  /** Ranked rows first, then the unranked ones by revisions; ties by path. */
  readonly rows: readonly JoinedHotspotRow<A>[];
  /** History files with no counterpart in the model (docs, build files, deleted files). */
  readonly outsideModel: number;
  /** Model files no mined commit touched. */
  readonly outsideHistory: number;
}

/**
 * THE JOINED HOTSPOT REPORT: each file the history and the model both know,
 * with its effort, its complexity, and its place in the four families.
 *
 * A score of 0 is NOT RANKED. It means "no effort" or "nothing measured", and
 * a file with thirty revisions and no measured operation must not be shown as
 * the simplest of the busy ones.
 */
export function joinedHotspots<A extends FileActivity>(
  activity: readonly A[],
  measures: ReadonlyMap<string, FileMeasure>,
  join: FileJoin,
  options: { readonly rank?: HotspotFamily | undefined } = {},
): JoinedHotspotReport<A> {
  const rank = options.rank ?? DEFAULT_HOTSPOT_FAMILY;
  type Draft = A & Omit<JoinedHotspotMeasures, "ranks"> & { ranks: Record<HotspotFamily, number | null> };
  const drafts: Draft[] = [];
  let outsideModel = 0;

  for (const row of activity) {
    const model = join.modelOf.get(row.path);
    const measure = model === undefined ? undefined : measures.get(model);
    if (model === undefined || measure === undefined) {
      outsideModel += 1;
      continue;
    }
    drafts.push({
      ...row,
      model,
      sloc: measure.sloc ?? null,
      cyclomatic: measure.cyclomatic ?? null,
      cycle: measure.cycle,
      scores: {
        classic: row.revisions * (measure.sloc ?? 0),
        branchy: row.revisions * (measure.cyclomatic ?? 0),
        tangled: measure.cycle > 0 ? row.revisions : 0,
        // revisions x (fixes / revisions): stated as the integer it is.
        fragile: row.fixes,
      },
      ranks: { classic: null, branchy: null, tangled: null, fragile: null },
    });
  }

  const by = (family: HotspotFamily) => (a: Draft, b: Draft): number =>
    b.scores[family] - a.scores[family] ||
    b.revisions - a.revisions ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const family of HOTSPOT_FAMILIES) {
    [...drafts].sort(by(family)).forEach((row, position) => {
      if (row.scores[family] > 0) row.ranks[family] = position + 1;
    });
  }
  drafts.sort(by(rank));

  let outsideHistory = 0;
  for (const file of measures.keys()) if (!join.historyOf.has(file)) outsideHistory += 1;

  return { rank, rows: drafts, outsideModel, outsideHistory };
}

export interface CrossModuleShare {
  /** The directory every joined model file lives under; "" when they share none. */
  readonly root: string;
  /** The top-level directories below `root`, sorted; "." is `root` itself. */
  readonly modules: readonly string[];
  /** Commits that touch at least one file of the model. */
  readonly commits: number;
  /** Of those, the ones that touch two top-level directories or more. */
  readonly crossing: number;
  /** crossing / commits; 0 — not NaN — when no commit touches the model. */
  readonly share: number;
  /** Commits over `maxChangesetSize` files, left out of both counts. */
  readonly skipped: number;
}

/**
 * HOW OFTEN A COMMIT CROSSES A MODULE — the number that says whether the
 * folders are boundaries (docs: discover/boundaries, check 3). A "module" here
 * is a TOP-LEVEL DIRECTORY of the model: the first path segment below the
 * directory all its files share. Paths, not ids — a path is the one thing the
 * history and the model both carry, and an id is never parsed (invariant 7).
 * In Java that segment is the first package below the common root.
 *
 * A changeset is the list of history paths one commit touched.
 */
export function crossModuleShare(
  changesets: Iterable<readonly string[]>,
  join: FileJoin,
  options: { readonly maxChangesetSize?: number | undefined } = {},
): CrossModuleShare {
  const directories = [...join.historyOf.keys()].map((file) => file.split("/").slice(0, -1));
  let shared = directories[0] ?? [];
  for (const directory of directories) {
    let length = 0;
    while (length < shared.length && length < directory.length && shared[length] === directory[length]) length += 1;
    shared = shared.slice(0, length);
  }
  const moduleOf = (modelFile: string): string => modelFile.split("/").slice(0, -1)[shared.length] ?? ".";

  const modules = new Set<string>();
  for (const file of join.historyOf.keys()) modules.add(moduleOf(file));

  let commits = 0;
  let crossing = 0;
  let skipped = 0;
  for (const changeset of changesets) {
    if (options.maxChangesetSize !== undefined && changeset.length > options.maxChangesetSize) {
      skipped += 1;
      continue;
    }
    const touched = new Set<string>();
    for (const path of changeset) {
      const model = join.modelOf.get(path);
      if (model !== undefined) touched.add(moduleOf(model));
    }
    if (touched.size === 0) continue;
    commits += 1;
    if (touched.size > 1) crossing += 1;
  }

  return {
    root: shared.join("/"),
    modules: sortIds(modules),
    commits,
    crossing,
    share: commits === 0 ? 0 : crossing / commits,
    skipped,
  };
}
