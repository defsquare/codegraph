/**
 * `@codegraph/core` — the metamodel, and the single place the vocabulary is
 * defined. Extractors conform to `schemas/model.schema.json` (generated from
 * `Model` here); analyzers and the future city renderer consume these types.
 */

// Primitives: ids, evidence, provenance, declaration space (METAMODEL.md §1).
export * from "./primitives.js";

// The closed trait and edge-kind vocabularies (METAMODEL.md §3, §4).
export * from "./names.js";

// Per-trait partial schemas (METAMODEL.md §3).
export * from "./traits.js";

// The single node concept (METAMODEL.md §2).
export * from "./entity.js";

// The single relationship concept (METAMODEL.md §4).
export * from "./edges.js";

// The interchange file (METAMODEL.md §8).
export * from "./model.js";

// The published cross-language contract, generated from the schemas above.
export * from "./jsonschema.js";

// Language profiles as data, plus validation (METAMODEL.md §5).
export * from "./profile.js";

// The nine shipped profiles and their registry.
export * from "./profiles/index.js";
