import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeModelToString, parseModel } from "@codegraph/core";
import { EXIT, UsageError } from "../src/exit.js";
import { loadExitCode, loadModelFiles } from "../src/load.js";

/** The real Spoon output: 166 entities, 173 edges, a clean bill of health. */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loading model files", () => {
  it("loads the java fixture as one clean union", () => {
    const loaded = loadModelFiles([FIXTURE]);
    expect(loaded.paths).toEqual([FIXTURE]);
    expect(loaded.union.entities.length).toBe(169);
    expect(loaded.union.edges.length).toBe(179);
    expect(loaded.union.langs).toEqual(["java"]);
    expect(loaded.clean).toBe(true);
    expect(loadExitCode(loaded)).toBe(EXIT.OK);
  });

  it("loads several paths as ONE union (decision 5)", () => {
    const loaded = loadModelFiles([FIXTURE, FIXTURE]);
    expect(loaded.union.models.length).toBe(2);
    expect(loaded.union.entities.length).toBe(338);
    // The same model twice duplicates every id — a finding, not a crash.
    expect(loaded.diagnostics.duplicateIds.length).toBe(169);
    expect(loaded.diagnostics.duplicateIds.every((d) => !d.conflicting)).toBe(true);
  });

  it("labels diagnostics with the path the user typed", () => {
    const bad = tempFile("broken.json", JSON.stringify({ schemaVersion: "1.0.0" }));
    const loaded = loadModelFiles([bad]);
    expect(loaded.diagnostics.schemaErrors.map((e) => e.label)).toEqual([bad]);
  });

  it("treats an unreadable path as a USAGE error, not a finding", () => {
    const missing = join(tmpdir(), "codegraph-does-not-exist-1234.json");
    let thrown: unknown;
    try {
      loadModelFiles([missing]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).exitCode).toBe(EXIT.USAGE);
    expect((thrown as UsageError).message).toContain(missing);
  });

  it("treats a malformed line as a finding: the tool worked, the file did not", () => {
    const path = tempFile("not-json.jsonl", "{ this is not json\n");
    const loaded = loadModelFiles([path]);
    expect(loaded.clean).toBe(false);
    expect(loadExitCode(loaded)).toBe(EXIT.FINDINGS);
    expect(loaded.diagnostics.schemaErrors[0]?.message).toContain("not a valid model.jsonl");
    expect(loaded.diagnostics.schemaErrors[0]?.message).toContain("line 1");
    expect(loaded.diagnostics.schemaErrors[0]?.label).toBe(path);
  });

  it("still reports the good files when one file is broken", () => {
    const broken = tempFile("broken.jsonl", "nope\n");
    const loaded = loadModelFiles([broken, FIXTURE]);
    expect(loaded.diagnostics.schemaErrors.length).toBe(1);
    expect(loaded.union.entities.length).toBe(169);
    expect(loadExitCode(loaded)).toBe(EXIT.FINDINGS);
  });

  it("reports a profile violation as findings while still loading the graph", () => {
    const model = {
      schemaVersion: "1.0.0",
      lang: "java",
      extractor: { name: "test", version: "0.0.0" },
      root: "/tmp/corpus",
      // Schema-valid (TNamed's key is present) but profile-invalid: java's
      // `class` kind requires TType, TChildOf, TSourceAnchor and more.
      // The module entity is required by the ENCODING (an entity names its
      // module by reference), not by the profile — the class stays invalid.
      entities: [
        { id: "java:x", kind: "package", traits: ["TNamed", "TModule"], name: "x", definedIn: [], isStub: false },
        { id: "java:x/Y", kind: "class", traits: ["TNamed"], name: "Y" },
      ],
      edges: [],
    };
    const path = tempFile("invalid-profile.jsonl", encodeModelToString(parseModel(model)));
    const loaded = loadModelFiles([path]);
    expect(loaded.union.entities.length).toBe(2);
    expect(loaded.diagnostics.profileIssues.length).toBeGreaterThan(0);
    expect(loadExitCode(loaded)).toBe(EXIT.FINDINGS);
  });
});
