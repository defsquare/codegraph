/**
 * `@codegraph/insights` — the bottom-up explanation walk and its side-car.
 *
 * PURE COMPUTATION: no filesystem, no network. Source text arrives through an
 * injected reader, the model through an injected `Completer`, finished records
 * leave through a hook. The CLI wires those to disk and to `@codegraph/llm`.
 *
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
 *   run.ts          executing a plan layer by layer
 *   sidecar.ts      the `.insights.jsonl` file and its journal
 */
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
export * from "./run.js";
export * from "./sidecar.js";
