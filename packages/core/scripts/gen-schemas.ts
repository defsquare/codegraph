/**
 * Emits `schemas/model.schema.json` — THE cross-language contract. A Java, Go
 * or .NET extractor validates its output against this file alone, with no
 * access to the TypeScript source, so everything the metamodel requires must
 * survive into the JSON Schema.
 *
 * The schema itself is built by `modelJsonSchema()` in `src/jsonschema.ts` (so
 * it is unit-testable); this script only canonicalizes and writes it. Output is
 * recursively key-sorted with a trailing newline so the file is diff-stable and
 * CI's `git diff --exit-code schemas/` only fires when the contract changed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { modelJsonSchema } from "../src/jsonschema.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Key-sort every object, leave arrays in declaration order (they are ordered data). */
function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key] as Json);
  }
  return out;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const outPath = join(repoRoot, "schemas", "model.schema.json");

const schema = canonicalize(modelJsonSchema() as Json);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${outPath}\n`);
