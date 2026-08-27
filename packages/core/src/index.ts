/**
 * `@codegraph/core` — the metamodel, and the single place the vocabulary is
 * defined. Extractors conform to `schemas/model.schema.json` (generated from
 * `Model` here); analyzers and the future city renderer consume these types.
 */

// Primitives: ids, evidence, provenance, declaration space (METAMODEL.md §1).
export * from "./primitives.js";

// The closed trait and edge-kind vocabularies (METAMODEL.md §3, §4).
export * from "./names.js";

// Structured identity and canonical order (METAMODEL.md §1.1, MM-1/MM-5).
export * from "./identity.js";

// Per-trait partial schemas (METAMODEL.md §3).
export * from "./traits.js";

// The single node concept (METAMODEL.md §2).
export * from "./entity.js";

// Written declaration-site values (METAMODEL.md §1.6).
export * from "./literal.js";

// The single relationship concept (METAMODEL.md §4).
export * from "./edges.js";

// The interchange file (METAMODEL.md §8a).
export * from "./model.js";

// The JSONL encoding: record schemas and the streaming codec (§8b).
export * from "./wire.js";
export * from "./jsonl.js";
export * from "./jsonl-file.js";

// The published cross-language contract, generated from the schemas above.
export * from "./jsonschema.js";
export * from "./container-contract.js";

// Graph-level integrity helpers: closure and self-reference (CLAUDE.md 4, 10).
export * from "./integrity.js";

// Language profiles as data, plus validation (METAMODEL.md §5).
export * from "./profile.js";

// The nine shipped profiles and their registry.
export * from "./profiles/index.js";
