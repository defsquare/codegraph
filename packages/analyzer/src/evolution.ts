import type { Edge, SourceAnchor } from "@codegraph/core";
import type { CodeGraph } from "./graph.js";

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
