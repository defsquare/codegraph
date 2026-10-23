/**
 * `@codegraph/vocabulary` — the words a corpus speaks (PLAN.md §20): every
 * name the model carries, split into words, each tagged with a class and
 * weighted by the role of the entity that carries it.
 *
 * PURE COMPUTATION, like `@codegraph/city`: reads names and a profile's
 * lexicon, never source, and touches no DOM.
 */
export * from "./split.js";
export * from "./classify.js";
export * from "./weight.js";
