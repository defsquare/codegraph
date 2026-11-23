import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  PROMPT_VERSION,
  WALK_DEFINITION_KIND,
  WALK_RECORDS_KIND,
  answerDigestOf,
  compileDefinition,
  encodeRecordsToString,
  parseWalkDefinition,
  sqliteInsightsStore,
  walkRecords,
  walkSidecarPathFor,
  walkStorePathFor,
  type WalkRecordsHeader,
} from "@codegraph/insights";
import { parseInvocation } from "../src/args.js";
import { captureIo } from "../src/io.js";
import { explainCommand, realSeam, type ExplainSeam } from "../src/commands/explain.js";

/**
 * EXPLAIN AND A WALK'S STORE (PLAN.md §22.4): explain pointed at another
 * walk's files — by `--out` — is a usage error naming both walks, on a real
 * disk, with every byte of that walk's store and side-car left as it was.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));

const compiled = compileDefinition(parseWalkDefinition({ kind: WALK_DEFINITION_KIND, name: "tx-boundaries", answer: { fields: { operation: { risky: "boolean" } } } }));
const format = walkRecords(compiled);
const header: WalkRecordsHeader = {
  t: "header",
  kind: WALK_RECORDS_KIND,
  walk: { name: compiled.name, version: compiled.version, digest: compiled.digest, answerDigest: answerDigestOf(compiled.answer) },
  generatedBy: INSIGHTS_GENERATOR,
  promptVersion: PROMPT_VERSION,
  models: { leaf: "m", rollup: "m" },
  depth: 1,
  source: { paths: ["model.jsonl"], langs: ["java"], view: { name: "all", filters: [] } },
};
const sidecar = encodeRecordsToString(
  format,
  header,
  [{ t: "i", id: "java:com.acme.order/Order.total()", level: "operation", kind: "method", origin: "llm", fingerprint: "a".repeat(64), block: { answer: "No.", risky: false, description: "Sums.", confidence: 0.5 } }],
  { t: "eof", counts: { records: 1, llm: 1, template: 0, reused: 0, failed: 0 }, usage: { promptTokens: 1, completionTokens: 1 }, generatedAt: "2026-11-21T00:00:00.000Z" },
);

function options(argv: readonly string[]) {
  const invocation = parseInvocation(["explain", FIXTURE, "--src", SRC, ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  return invocation.options;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const seam: ExplainSeam = { ...realSeam(), env: {}, clientFor: () => { throw new Error("no call is made"); }, confirm: async () => true };

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("explain refuses a walk's store, naming both walks, bytes untouched", () => {
  it("--dry-run, --export and --import on <model>.N.walk.*", async () => {
    dir = mkdtempSync(join(tmpdir(), "explain-walk-store-"));
    const model = join(dir, "model.jsonl");
    const out = walkSidecarPathFor(model, "tx-boundaries");
    const store = walkStorePathFor(model, "tx-boundaries");
    writeFileSync(out, sidecar);
    const db = sqliteInsightsStore(loadSqlite().open(store), { format });
    db.importFile({ header, records: [], failures: [], eof: undefined, truncated: true });
    db.close();
    const before = { store: sha256(store), out: sha256(out), entries: readdirSync(dir).sort() };

    for (const argv of [["--dry-run"], ["--export"], ["--import", out, "--yes"]]) {
      const run = explainCommand(options(["--out", out, ...argv]), captureIo(), seam);
      await expect(run, argv.join(" ")).rejects.toThrow(/the walk "tx-boundaries" \(codegraph\.walkRecords\/1\), not of the walk "explain" \(codegraph\.insights\/1\)/u);
      expect(sha256(store), argv.join(" ")).toBe(before.store);
      expect(sha256(out), argv.join(" ")).toBe(before.out);
      expect(readdirSync(dir).sort(), argv.join(" ")).toEqual(before.entries);
    }
    // The store's refusal says each walk keeps its own; the side-car's (--import reads it first) says what it is.
    await expect(explainCommand(options(["--out", out, "--dry-run"]), captureIo(), seam)).rejects.toMatchObject({ hint: expect.stringMatching(/Each walk keeps its own store/u) });
    await expect(explainCommand(options(["--out", out, "--import", out, "--yes"]), captureIo(), seam)).rejects.toThrow(/is not a codegraph\.insights\/1 side-car: line 1 is the header of the walk "tx-boundaries"/u);
  });
});
