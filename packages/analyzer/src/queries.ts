import type { EntityId } from "@codegraph/core";
import type { FoldedGraph } from "./fold.js";
import type { CodeGraph } from "./graph.js";
import type { View } from "./views.js";

/**
 * SEAM — the query slice fills these in.
 *
 * Both return a `FoldedGraph`, so the pipeline stays uniform:
 *   load -> CodeGraph -> view -> fold -> (queries | metrics) -> export
 *
 * Implementation notes for the slice that lands here:
 *  - `importGraph` folds `import` edges to `module` level. Module→module is the
 *    only layer comparable across every language (CLAUDE.md invariant 9), and
 *    folding is the identity on an edge already written between two modules —
 *    which is why this can be one code path for every extractor.
 *  - `typeDependencyGraph` folds ALL edge kinds to `type` level.
 *  - Neither may re-derive facts the graph already indexes, and neither may
 *    mutate the model.
 */

/** Module→module import graph under `view`. Defaults to the identity view. */
export function importGraph(_graph: CodeGraph, _view?: View): FoldedGraph {
  throw new Error("M3: queries slice fills this in");
}

/** All edge kinds folded to their containing types, under `view`. */
export function typeDependencyGraph(_graph: CodeGraph, _view?: View): FoldedGraph {
  throw new Error("M3: queries slice fills this in");
}

/** Direct dependencies of a folded node, sorted. */
export function dependenciesOf(_folded: FoldedGraph, _id: EntityId): readonly EntityId[] {
  throw new Error("M3: queries slice fills this in");
}

/** Direct dependents of a folded node, sorted. */
export function dependentsOf(_folded: FoldedGraph, _id: EntityId): readonly EntityId[] {
  throw new Error("M3: queries slice fills this in");
}
