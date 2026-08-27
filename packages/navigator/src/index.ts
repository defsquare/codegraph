/**
 * `@codegraph/navigator` — the navigator model: the browsable tree of a corpus
 * (modules → types → operations/attributes) plus one classified dependency row
 * per base edge, for the fan-in / fan-out explorer.
 *
 * PURE COMPUTATION, like `@codegraph/city`: reads a `CodeGraph`, writes
 * nothing back, touches no DOM and no React. `packages/navigator-ui` renders
 * this package's JSON artefact and nothing else.
 */
export * from "./model.js";
export * from "./roles.js";
export * from "./build.js";
export * from "./json.js";
