/**
 * `@codegraph/insights` — the bottom-up explanation walk and its side-car.
 *
 * PURE COMPUTATION: no filesystem, no network. Source text arrives through an
 * injected reader, the model through an injected `Completer`, finished records
 * leave through a hook, and the store adapter is handed an OPEN database. The
 * CLI wires those to disk, to Node's SQLite builtin and to `@codegraph/llm`.
 *
 *   spec.ts         THE SEAM: `WalkSpec`, what a walk decides and the engine does not
 *   explain-spec.ts the built-in walk: Specy rules, words, blocks, templates, quote, estimate
 *   ddd.ts          the Specy domain vocabulary, restated
 *   schema.ts       Zod blocks and records → types, validators, strict JSON Schema
 *   units.ts        what gets explained (operations, types, modules) + template rule
 *   order.ts        the SCC-condensed, Kahn-layered walk order
 *   source.ts       source slices from anchors
 *   context.ts      the context pack: facts + source + dependency explanations
 *   prompt.ts       deterministic prompts, fenced material
 *   fingerprint.ts  Merkle fingerprints for incremental runs
 *   template.ts     blocks for trivial members, no model call
 *   plan.ts         statuses and estimates before spending anything
 *   selection.ts    which units a walk asks: includes, excludes, levels, closure, trivial → `inScope`
 *   definition.ts   `codegraph.walk/1`: a walk as data → a spec + a selection; explain, customized
 *   run.ts          executing a plan layer by layer
 *   records.ts      what is already explained, as the walk reads it: fingerprints apart from blocks
 *   format.ts       one store per walk: a walk's name, header and schemas; the name check; a changed definition
 *   sidecar.ts      the side-car file (`.insights.jsonl`, a walk's `.N.walk.jsonl`) — the store's export
 *   store.ts        the store's port: `<model>.insights.db` / `<model>.N.walk.db`, never a cache
 *   store-sqlite.ts its SQLite adapter, over a database the caller opened
 *   glossary.ts     the readers of the words: by word, polysemy, concerns (M19c)
 */
export * from "./spec.js";
export * from "./explain-spec.js";
export * from "./ddd.js";
export * from "./schema.js";
export * from "./units.js";
export * from "./order.js";
export * from "./source.js";
export * from "./context.js";
export * from "./prompt.js";
export * from "./fingerprint.js";
export * from "./template.js";
export * from "./plan.js";
export * from "./selection.js";
export * from "./definition.js";
export * from "./records.js";
export * from "./run.js";
export * from "./format.js";
export * from "./sidecar.js";
export * from "./store.js";
export * from "./store-sqlite.js";
export * from "./glossary.js";
