/**
 * Emits `schemas/` — THE cross-language contract. A Java, Go or .NET extractor
 * validates its output against these files alone, with no access to the
 * TypeScript source, so everything the metamodel requires must survive into
 * them: what a single line must look like into the per-record JSON Schemas,
 * and what only the SEQUENCE of lines can express into `README.md`.
 *
 * The schemas are built by `recordJsonSchemas()` in `src/jsonschema.ts` (so they
 * are unit-testable); this script only canonicalizes and writes them. Output is
 * recursively key-sorted with a trailing newline so the files are diff-stable
 * and CI's `git diff --exit-code schemas/` only fires when the contract changed.
 */
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { recordJsonSchemas } from "../src/jsonschema.js";
import { containerContract } from "../src/container-contract.js";

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
const schemasDir = join(repoRoot, "schemas");

await mkdir(schemasDir, { recursive: true });

// A stale schema file is worse than a missing one: an extractor would validate
// against a contract nothing generates any more.
const written = new Set<string>(["README.md"]);
const schemas = recordJsonSchemas();
for (const [tag, schema] of Object.entries(schemas)) {
  const name = `${tag}.record.schema.json`;
  written.add(name);
  await writeFile(
    join(schemasDir, name),
    `${JSON.stringify(canonicalize(schema as Json), null, 2)}\n`,
    "utf8",
  );
}

await writeFile(join(schemasDir, "README.md"), containerContract(), "utf8");

for (const existing of await readdir(schemasDir)) {
  if (!written.has(existing)) {
    await unlink(join(schemasDir, existing));
    process.stdout.write(`removed stale ${existing}\n`);
  }
}

process.stdout.write(`wrote ${written.size} files to ${schemasDir}\n`);
