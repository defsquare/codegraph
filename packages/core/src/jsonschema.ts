import { z } from "zod";
import { SCHEMA_VERSION } from "./model.js";
import { RECORD_SCHEMAS, SECTION_ORDER, type RecordTag } from "./wire.js";

export type JsonSchema = { [key: string]: unknown };

/**
 * The published cross-language contract: one JSON Schema per JSONL record type,
 * so a Java, Go or .NET extractor can validate its output **line by line** with
 * no access to this TypeScript source.
 *
 * What a per-record schema CANNOT express, and what `schemas/README.md` states
 * in prose instead:
 *  - the container — section order, one header, one eof — because JSON Schema
 *    describes a document, and a JSONL file is a sequence of them;
 *  - dictionary resolution — `k`/`tr`/`p` are indices whose meaning lives in the
 *    header, which a single-line validator cannot see;
 *  - the trait-key rule (METAMODEL §2), for the same reason: which keys an
 *    entity record must carry depends on resolving `tr` through the header.
 *    v1 could state it as `if/then` conditionals because traits were inline
 *    names; that is the one thing interning cost us, and it is stated in the
 *    container contract and enforced by every reader.
 *
 * Everything else IS enforced: every field's type, every reference being a
 * non-negative integer, spans being 1-based, the closed vocabularies.
 */
export function recordJsonSchemas(): Record<RecordTag, JsonSchema> {
  const out = {} as Record<RecordTag, JsonSchema>;
  for (const tag of SECTION_ORDER) {
    const generated = z.toJSONSchema(RECORD_SCHEMAS[tag], {
      target: "draft-2020-12",
      io: "input",
    }) as JsonSchema;
    out[tag] = {
      ...generated,
      $id: `https://codegraph.dev/schemas/${tag}.record-${SCHEMA_VERSION}.schema.json`,
      title: `Codegraph model.jsonl "${tag}" record (interchange contract ${SCHEMA_VERSION})`,
      description: RECORD_DESCRIPTIONS[tag],
    };
  }
  return out;
}

const RECORD_DESCRIPTIONS: Record<RecordTag, string> = {
  header:
    "First line of the file. Carries the model's own facts and the dictionaries every " +
    "other record indexes into. Exactly one per file.",
  f:
    "One interned file path. `i` is its own index: dense, ascending from 0, gap-free. " +
    "Anchors and `definedIn` reference these.",
  e:
    "One entity. `i` is its surrogate and equals its position in the section; `m`/`s`/`d` " +
    "are the natural key, with `lang` taken from the header — no rendered id appears in the " +
    "file. A module names ITSELF in `m` and writes its own path in `s`.",
  x:
    "One edge, outgoing direction only. `f`/`o` are entity surrogates, `k` and `p` index the " +
    "header's edge-kind and provenance dictionaries.",
  eof:
    "Trailer. The counts make truncation detectable: a reader that reaches end-of-input " +
    "without this record, or whose tallies disagree with it, must reject the file.",
};
