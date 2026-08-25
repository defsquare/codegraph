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
 * PLACEMENT IS A SEPARATE PASS. `buildCity` emits no coordinates; `layoutCity`
 * (layout.ts) takes that city and adds them — `position` on buildings, `bounds`
 * on districts — by recursive shelf packing that favours a readable city over a
 * dense one. Keeping the passes apart is what keeps the packer replaceable.
 */
export * from "./metrics.js";
export * from "./scale.js";
export * from "./city.js";
export * from "./layout.js";
export * from "./replay.js";
export * from "./json.js";
