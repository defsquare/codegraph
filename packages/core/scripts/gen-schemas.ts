/**
 * Emits `schemas/model.schema.json` — THE cross-language contract. A Java, Go
 * or .NET extractor validates its output against this file alone, with no
 * access to the TypeScript source, so everything the metamodel requires must
 * survive into the JSON Schema.
 *
 * Output is canonicalized (recursively key-sorted, trailing newline) so the
 * file is diff-stable and CI's `git diff --exit-code schemas/` only fires when
 * the contract actually changed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { Model, SCHEMA_VERSION } from "../src/model.js";

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

const generated = z.toJSONSchema(Model, { target: "draft-2020-12" }) as unknown as {
  [key: string]: Json;
};

const schema = canonicalize({
  ...generated,
  $id: `https://codegraph.dev/schemas/model-${SCHEMA_VERSION}.schema.json`,
  title: `Codegraph model.json (interchange contract ${SCHEMA_VERSION})`,
  description:
    "One extraction run: entities (nodes composed of traits) and edges (outgoing only, " +
    "each carrying provenance and an anchor). Generated from @codegraph/core — edit the " +
    "Zod schemas and re-run `pnpm run gen:schemas`, never this file.",
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${outPath}\n`);
