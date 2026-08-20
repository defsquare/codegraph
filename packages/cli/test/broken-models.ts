import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeModelToString, readModelFileSync, type Model } from "@codegraph/core";
import { javaFixture } from "./cli-process.js";

/**
 * Corrupted copies of the java fixture, written to a throwaway directory.
 *
 * Exit code 3 means "the tool worked; your model did not", so a test for it has
 * to feed the CLI a genuinely broken model — never a broken invocation, which
 * is exit 2. Each builder here targets ONE bucket of `LoadDiagnostics`, and the
 * bucket it lands in was verified against `loadModels` before the test was
 * written rather than assumed:
 *
 *   malformedJson      schemaErrors      (a line is not JSON at all)
 *   notAModel          schemaErrors      (valid JSON, not a model record)
 *   truncated          schemaErrors      (no eof — a killed writer, v1 could
 *                                        not detect this at all)
 *   danglingReference  schemaErrors      (see below)
 *   selfEdge           selfEdges
 *   profileViolation   profileIssues (missing-required-trait)
 *   conflictingCopy    duplicateIds with conflicting: true, and NOTHING else —
 *                      it adds java's one optional trait (TComment) plus the
 *                      `comments` key the trait requires, so the copy stays
 *                      profile-valid while its trait SET differs, which is what
 *                      `sameDeclaration` compares.
 *
 * **A dangling reference is no longer a FINDING about a valid file — it is a
 * malformed file.** In v1 a reference was an id string, so a model could name
 * something nothing declared and still parse; the analyzer reported it
 * afterwards. In v2 a reference is a surrogate into this file's own entity
 * section, so "points at nothing" cannot be written and cannot be read: the
 * decoder refuses it as a closure violation. The `danglingReferences` bucket
 * still exists for models built in memory, but a FILE can no longer produce one.
 *
 * The fixture itself is never modified; every builder re-reads it.
 */

/** The id whose declaration the conflicting copy disagrees about. */
export const CONFLICTING_ID = "java:com.acme.order";

/** The endpoint of the self-edge, filled in when the models are built. */
export let SELF_EDGE_ID = "";

export interface BrokenModels {
  /** The temp directory holding every generated file. */
  readonly dir: string;
  /** A pristine copy of the fixture, for union tests that need two paths. */
  readonly pristineCopy: string;
  readonly malformedJson: string;
  readonly notAModel: string;
  readonly truncated: string;
  readonly danglingReference: string;
  readonly selfEdge: string;
  readonly profileViolation: string;
  readonly conflictingCopy: string;
  /** Remove everything. Call from `afterAll`. */
  cleanup(): void;
}

function readFixture(): Model {
  return readModelFileSync(javaFixture());
}

/** Writes a model through core's encoder — the same bytes the extractor emits. */
function write(dir: string, name: string, model: Model): string {
  const path = join(dir, name);
  writeFileSync(path, encodeModelToString(model), "utf8");
  return path;
}

/** Writes raw text, for corruptions no encoder would produce. */
function writeText(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

function requireEntity(model: Model, id: string): Record<string, unknown> {
  const entity = model.entities.find((candidate) => candidate.id === id);
  if (entity === undefined) throw new Error(`the java fixture no longer declares ${id}`);
  return entity as unknown as Record<string, unknown>;
}

export function createBrokenModels(): BrokenModels {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-e2e-"));
  const fixtureText = readFileSync(javaFixture(), "utf8");
  const lines = fixtureText.split("\n").filter((line) => line !== "");

  // A self-edge is still WRITABLE — the contract forbids it, so something has to
  // be able to report it, and that reporter is the analyzer.
  const selfy = readFixture();
  const firstEdge = selfy.edges[0];
  if (firstEdge === undefined) throw new Error("the java fixture has no edges");
  const selfEdge: Model = {
    ...selfy,
    edges: [{ ...firstEdge, to: firstEdge.from }, ...selfy.edges.slice(1)],
  };
  SELF_EDGE_ID = firstEdge.from;

  const profileBroken = readFixture();
  const someClass = profileBroken.entities.find((entity) => entity.kind === "class");
  if (someClass === undefined) throw new Error("the java fixture no longer declares any class");
  (someClass as unknown as Record<string, unknown>)["traits"] = ["TNamed"];

  const conflicting = readFixture();
  const disputed = requireEntity(conflicting, CONFLICTING_ID);
  disputed["traits"] = [...(disputed["traits"] as string[]), "TComment"];
  disputed["comments"] = ["a second, disagreeing declaration of the same id"];

  // Edited as TEXT: an out-of-range surrogate is precisely what the encoder
  // refuses to produce, which is the point of the case.
  const lastEdgeIndex = lines.findLastIndex((line) => line.startsWith('{"t":"x"'));
  const edgeRecord = JSON.parse(lines[lastEdgeIndex]!) as Record<string, unknown>;
  edgeRecord["o"] = 999_999;
  const dangling = [
    ...lines.slice(0, lastEdgeIndex),
    JSON.stringify(edgeRecord),
    ...lines.slice(lastEdgeIndex + 1),
  ].join("\n");

  return {
    dir,
    pristineCopy: write(dir, "pristine.jsonl", readFixture()),
    malformedJson: writeText(dir, "malformed.jsonl", `${lines[0]!}\n{"t":"e", not json\n`),
    notAModel: writeText(dir, "not-a-model.jsonl", '{"hello":"this is json, but it is not a record"}\n'),
    truncated: writeText(dir, "truncated.jsonl", `${lines.slice(0, -1).join("\n")}\n`),
    danglingReference: writeText(dir, "dangling.jsonl", `${dangling}\n`),
    selfEdge: write(dir, "self-edge.jsonl", selfEdge),
    profileViolation: write(dir, "profile-violation.jsonl", profileBroken),
    conflictingCopy: write(dir, "conflicting.jsonl", conflicting),
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A path inside the temp dir that no file occupies — for `--out` tests. */
export function scratchPath(models: BrokenModels, name: string): string {
  return join(models.dir, name);
}
