/**
 * `@codegraph/analyzer` — graph construction, derived indexes, queries,
 * metrics and exports (PLAN.md §6, METAMODEL.md §9).
 *
 * PURE COMPUTATION. Nothing here mutates a model, writes back into one, or
 * serializes a derived inverse index (CLAUDE.md invariant 4). It runs in plain
 * Node with no DOM and never imports Three.js — `packages/viz` consumes this
 * package's output, not the other way round.
 *
 * THE PIPELINE — every analysis is this one flow, and each stage is a pure
 * function of the previous one:
 *
 *   loadModels(inputs)            -> LoadResult { union, diagnostics }
 *     buildGraph(union)           -> CodeGraph            (entity map + derived inverse indexes)
 *       view: internalOnly / declaredOnly / composeViews(...)  (predicate pair, no copy)
 *         foldGraph(graph, {level, view})  -> FoldedGraph (aggregated weighted edges)
 *           queries: importGraph(graph, view) | typeDependencyGraph(graph, view)
 *           metrics: coupling(folded) | cycles(folded)
 *             exports: toDot(folded) | foldedGraphToCsv(folded) | couplingToCsv(table)
 *                    | foldedGraphToJson(folded) | toJsonString(...)
 *
 * A folded graph carries the level and the view it was built under, and every
 * metric table and export repeats them: a coupling number without its view is
 * not a fact.
 */

// Deterministic ordering helpers — every output is sorted with these.
export * from "./order.js";

// Stage 1: load, validate, unify (schema errors fatal, profile issues collected).
export * from "./load.js";

// The acceptance gate: the PLAN.md §8 invariants checked over a loaded union.
// Composes core's integrity and profile validation; adds the candidates, anchor
// and union-wide redeclaration rules nothing else checks.
export * from "./conformance.js";

// Stage 2: the indexed model and its derived, never-serialized inverse indexes.
export * from "./graph.js";

// Stage 3: views as predicate pairs over the base graph.
export * from "./views.js";

// Stage 4: folding to type/module level, with aggregated weighted edges.
export * from "./fold.js";

// Stage 5: the two comparable layers — module imports and type dependencies —
// plus the neighbourhood of one entity (METAMODEL.md §9).
export * from "./queries.js";

// Stage 6: metrics over a folded graph. Each result repeats the level and view
// it was computed under; a coupling number without its view is not a fact.
export * from "./metrics/coupling.js";
export * from "./metrics/cycles.js";

// Stage 7: renderings. Derived and dynamic-candidate relations stay visually
// distinguishable from declared facts, and stubs from corpus entities.
export * from "./exports/dot.js";
export * from "./exports/plantuml.js";
export * from "./exports/csv.js";
export * from "./exports/json.js";

// M7: the analysis store. `model.db` is a DERIVED, DISPOSABLE cache of a
// `.jsonl` model — regenerable at any time, never committed, never the
// interchange (PLAN.md §9.3). `store/sqlite.ts` is the only module in the
// workspace allowed to load Node's SQLite builtin, and it is the only one
// allowed to NAME it — `source-hygiene.test.ts` enforces that as a substring
// count, which is why this comment spells it out the long way.
export * from "./store/sqlite.js";
export * from "./store/schema.js";
export * from "./store/import.js";
