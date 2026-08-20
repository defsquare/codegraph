import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 *   malformedJson      schemaErrors      (the file is not JSON at all)
 *   notAModel          schemaErrors      (valid JSON, not a Model)
 *   danglingReference  danglingReferences
 *   selfEdge           selfEdges
 *   profileViolation   profileIssues (6 × missing-required-trait)
 *   conflictingCopy    duplicateIds with conflicting: true, and NOTHING else —
 *                      it adds java's one optional trait (TComment) plus the
 *                      `comments` key the trait requires, so the copy stays
 *                      profile-valid while its trait SET differs, which is what
 *                      `sameDeclaration` compares.
 *
 * The fixture itself is never modified; every builder deep-copies it.
 */

/** Loosely typed on purpose — these are deliberately-invalid models. */
type MutableModel = {
  entities: { id: string; kind: string; traits: string[]; comments?: string[] }[];
  edges: { from: string; to: string }[];
  [key: string]: unknown;
};

/** The id whose declaration the conflicting copy disagrees about. */
export const CONFLICTING_ID = "java:com.acme.order";

/** An id no corpus entity has, used as a dangling edge target. */
export const UNKNOWN_ID = "java:nowhere.at.all/Missing";

export interface BrokenModels {
  /** The temp directory holding every generated file. */
  readonly dir: string;
  /** A pristine copy of the fixture, for union tests that need two paths. */
  readonly pristineCopy: string;
  readonly malformedJson: string;
  readonly notAModel: string;
  readonly danglingReference: string;
  readonly selfEdge: string;
  readonly profileViolation: string;
  readonly conflictingCopy: string;
  /** Remove everything. Call from `afterAll`. */
  cleanup(): void;
}

function readFixture(): MutableModel {
  return JSON.parse(readFileSync(javaFixture(), "utf8")) as MutableModel;
}

function write(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
  return path;
}

function requireEntity(model: MutableModel, id: string): MutableModel["entities"][number] {
  const entity = model.entities.find((candidate) => candidate.id === id);
  if (entity === undefined) throw new Error(`the java fixture no longer declares ${id}`);
  return entity;
}

function requireEdge(model: MutableModel, index: number): MutableModel["edges"][number] {
  const edge = model.edges[index];
  if (edge === undefined) throw new Error(`the java fixture has no edge at index ${index}`);
  return edge;
}

export function createBrokenModels(): BrokenModels {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-e2e-"));

  const dangling = readFixture();
  requireEdge(dangling, 0).to = UNKNOWN_ID;

  const selfy = readFixture();
  const firstEdge = requireEdge(selfy, 0);
  firstEdge.to = firstEdge.from;

  const profileBroken = readFixture();
  const someClass = profileBroken.entities.find((entity) => entity.kind === "class");
  if (someClass === undefined) throw new Error("the java fixture no longer declares any class");
  someClass.traits = ["TNamed"];

  const conflicting = readFixture();
  const disputed = requireEntity(conflicting, CONFLICTING_ID);
  disputed.traits = [...disputed.traits, "TComment"];
  disputed.comments = ["a second, disagreeing declaration of the same id"];

  return {
    dir,
    pristineCopy: write(dir, "pristine.json", readFixture()),
    malformedJson: write(dir, "malformed.json", '{"schemaVersion": "1.0.0", "entities": [\n'),
    notAModel: write(dir, "not-a-model.json", { hello: "this is json, but it is not a model" }),
    danglingReference: write(dir, "dangling.json", dangling),
    selfEdge: write(dir, "self-edge.json", selfy),
    profileViolation: write(dir, "profile-violation.json", profileBroken),
    conflictingCopy: write(dir, "conflicting.json", conflicting),
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A path inside the temp dir that no file occupies — for `--out` tests. */
export function scratchPath(models: BrokenModels, name: string): string {
  return join(models.dir, name);
}
