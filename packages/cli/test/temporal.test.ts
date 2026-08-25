import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Entity, type Model } from "@codegraph/core";

import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph import --at` + `codegraph timeline`, end to end in-process (M9b).
 * The corpus story matches the analyzer's temporal suite: A lives throughout,
 * B dies after revision one, C is born at revision two.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-temporal-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40) } as const;
const storePath = join(scratch, "story.db");

const moduleId = renderId({ lang: "java", module: "app", symbol: "" });
const id = (symbol: string): string => renderId({ lang: "java", module: "app", symbol });

// Profile-clean shapes: `import` diagnoses the store it wrote, and a toy
// missing a required trait would turn every exit code below into 3.
function type(symbol: string, loc: number): Entity {
  return {
    id: id(symbol),
    kind: "class",
    traits: [
      "TNamed", "TType", "TWithInheritances", "TWithImplements",
      "TWithChildren", "TChildOf", "TSourceAnchor",
    ],
    name: symbol,
    isStub: false,
    parent: moduleId,
    anchor: { file: `app/${symbol}.java`, span: [1, loc] },
  } as unknown as Entity;
}

function snapshot(name: string, types: [string, number][]): string {
  const model: Model = {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo",
    entities: [
      {
        id: moduleId,
        kind: "package",
        traits: ["TNamed", "TModule", "TWithChildren"],
        name: "app",
        definedIn: ["app/package-info.java"],
        isStub: false,
      } as unknown as Entity,
      ...types.map(([symbol, loc]) => type(symbol, loc)),
    ],
    edges: [],
  } as unknown as Model;
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, encodeModelToString(model), "utf8");
  return path;
}

function invoke(argv: readonly string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = run(argv, io);
  return { io, code };
}

describe("codegraph import --at accumulates revisions", () => {
  it("imports three snapshots into one store", () => {
    const revisions: [string, [string, number][], string][] = [
      [SHA.a, [["A", 20], ["B", 10]], "1000"],
      [SHA.b, [["A", 35], ["C", 5]], "2000"],
      [SHA.c, [["A", 30], ["C", 8]], "3000"],
    ];
    for (const [index, [sha, types, time]] of revisions.entries()) {
      const { io, code } = invoke([
        "import", snapshot(`rev-${index}`, types),
        "--at", sha, "--time", time, "--out", storePath,
      ]);
      expect(code).toBe(EXIT.OK);
      expect(io.stdout()).toContain(`@ ${sha} (revision ${index + 1} in the store)`);
    }
  });

  it("refuses the same sha twice, changing nothing (exit 2)", () => {
    const { io, code } = invoke([
      "import", snapshot("dup", [["A", 20]]),
      "--at", SHA.a, "--out", storePath,
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("already in the store");
    expect(io.stdout()).toBe("");
  });

  it("refuses --at with several models", () => {
    const { io, code } = invoke([
      "import", snapshot("m1", [["A", 1]]), snapshot("m2", [["A", 2]]), "--at", SHA.a,
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--at takes one model");
  });

  it("refuses --time without --at, and an unreadable --time", () => {
    expect(invoke(["import", snapshot("t1", [["A", 1]]), "--time", "12"]).code).toBe(EXIT.USAGE);
    expect(
      invoke(["import", snapshot("t2", [["A", 1]]), "--at", SHA.a, "--time", "not-a-date"]).code,
    ).toBe(EXIT.USAGE);
  });

  it("accepts an ISO --time", () => {
    const path = join(scratch, "iso.db");
    const { code } = invoke([
      "import", snapshot("iso", [["A", 1]]),
      "--at", SHA.a, "--time", "2024-01-01T10:00:00Z", "--out", path,
    ]);
    expect(code).toBe(EXIT.OK);
  });
});

describe("codegraph timeline", () => {
  it("reports A's whole life with the hand-counted LOC series", () => {
    const { io, code } = invoke(["timeline", id("A"), "--store", storePath]);
    expect(code).toBe(EXIT.OK);
    const text = io.stdout();
    expect(text).toContain("3 of 3 revisions");
    expect(text).toContain(`appeared:  ${SHA.a.slice(0, 7)}`);
    expect(text).toContain("still in the latest revision");
    expect(text).toMatch(/aaaaaaa.*20/);
    expect(text).toMatch(/bbbbbbb.*35/);
    expect(text).toMatch(/ccccccc.*30/);
  });

  it("says when a key disappeared", () => {
    const { io, code } = invoke(["timeline", id("B"), "--store", storePath]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain(`last seen: ${SHA.a.slice(0, 7)}`);
    expect(io.stdout()).toContain("gone since");
  });

  it("answers — exit 0 — for a key that never appears", () => {
    const { io, code } = invoke(["timeline", id("Nowhere"), "--store", storePath]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("never appears in any of the 3 revisions");
  });

  it("--json carries the series machine-readably", () => {
    const { io, code } = invoke(["timeline", id("C"), "--store", storePath, "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      appeared: { sha: string };
      presentInLatest: boolean;
      series: { loc: number }[];
    };
    expect(parsed.appeared.sha).toBe(SHA.b);
    expect(parsed.presentInLatest).toBe(true);
    expect(parsed.series.map((point) => point.loc)).toEqual([5, 8]);
  });

  it("refuses a malformed id as a usage error", () => {
    const { code, io } = invoke(["timeline", "not an id", "--store", storePath]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("rendered entity id");
  });

  it("refuses a missing store, naming how to build one", () => {
    const { code, io } = invoke(["timeline", id("A"), "--store", join(scratch, "nowhere.db")]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("import");
    expect(io.stderr()).toContain("--at");
  });

  it("refuses a plain single-model cache — no revisions to walk", () => {
    const flat = join(scratch, "flat.db");
    expect(invoke(["import", snapshot("flat", [["A", 1]]), "--out", flat]).code).toBe(EXIT.OK);
    const { code, io } = invoke(["timeline", id("A"), "--store", flat]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("holds no revisions");
  });
});
