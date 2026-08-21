/**
 * `@codegraph/city` — the CITY MODEL: a second, derived model whose vocabulary
 * is districts, buildings and arrows rather than entities and edges.
 *
 *   module (TModule)   ->  DISTRICT   the landscape a building stands on
 *   type   (TType)     ->  BUILDING   dimensions from configurable metrics
 *   type dependency    ->  ARROW      drawn roof to roof, weighted by count
 *
 * PURE COMPUTATION, like the analyzer: no DOM, no Three.js, no file I/O. It
 * reads the analyzer's graph and produces data; `packages/viz` will render this
 * output and must not re-derive any of it.
 *
 * PLACEMENT IS NOT HERE. No building has a position, no district has bounds.
 * Each district carries the base area its buildings demand, which is what a
 * later layout / 2D bin-packing pass consumes — that pass adds coordinates and
 * has nothing here to undo.
 */
export * from "./metrics.js";
export * from "./scale.js";
export * from "./city.js";
export * from "./json.js";
