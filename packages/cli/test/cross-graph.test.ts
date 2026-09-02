import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Edge, type Entity, type Model } from "@codegraph/core";
import { HISTORY_SCHEMA_VERSION, encodeHistoryToString, type History } from "@codegraph/scm";

import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * The cross-graph reports (M9b), end to end: one mined history + one model,
 * joined on paths by suffix. Hand-counted story —
 *
 *   declared graph:  A.java -> B.java -> C.java        D.java: no edges
 *   co-changes:      A+B ×3 (declared: explained)      B+D ×3 (HIDDEN)
 *                    B and C never co-change           (B -> C is DEAD WEIGHT)
 *
 * History paths carry a `src/` prefix the model does not — the join must
 * bridge exactly that.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-crossgraph-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const hash = (n: number): string => n.toString(16).padStart(40, "0");
const HIST = {
  a: "src/com/x/A.java",
  b: "src/com/x/B.java",
  c: "src/com/x/C.java",
  d: "src/com/x/D.java",
} as const;

function historyFile(): string {
  const paths = ["docs/readme.md", HIST.a, HIST.b, HIST.c, HIST.d].sort();
  const at = (path: string): number => paths.indexOf(path);
  const changesets: string[][] = [
    [HIST.a, HIST.b],
    [HIST.a, HIST.b],
    [HIST.a, HIST.b],
    [HIST.b, HIST.d],
    [HIST.b, HIST.d],
    [HIST.b, HIST.d],
    [HIST.c],
    ["docs/readme.md"],
  ];
  const history: History = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    scm: "git",
    miner: "codegraph-scm@test",
    repo: "demo",
    authors: ["Alice <a@x>"],
    paths,
    commits: changesets.map((_, index) => ({
      hash: hash(index),
      author: 0,
      time: 1000 + index,
      isFix: false,
      isRevert: false,
    })),
    changes: changesets.flatMap((files, commit) =>
      files
        .map((file) => at(file))
        .sort((x, y) => x - y)
        .map((path) => ({ commit, path, added: 1, deleted: 0 })),
    ),
  };
  const path = join(scratch, "demo-history.jsonl");
  writeFileSync(path, encodeHistoryToString(history), "utf8");
  return path;
}

const moduleId = renderId({ lang: "java", module: "com.x", symbol: "" });
const id = (symbol: string): string => renderId({ lang: "java", module: "com.x", symbol });

function type(symbol: string): Entity {
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
    anchor: { file: `com/x/${symbol}.java`, span: [1, 10] },
  } as unknown as Entity;
}

function modelFile(): string {
  const edge = (from: string, to: string): Edge =>
    ({
      edge: "reference",
      from: id(from),
      to: id(to),
      provenance: "declared",
      anchor: { file: `com/x/${from}.java`, span: [1, 1] },
    }) as unknown as Edge;
  const model: Model = {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo/src",
    entities: [
      {
        id: moduleId,
        kind: "package",
        traits: ["TNamed", "TModule", "TWithChildren"],
        name: "com.x",
        definedIn: ["com/x/A.java"],
        isStub: false,
      } as unknown as Entity,
      type("A"),
      type("B"),
      type("C"),
      type("D"),
    ],
    edges: [edge("A", "B"), edge("B", "C")],
  } as unknown as Model;
  const path = join(scratch, "demo-model.jsonl");
  writeFileSync(path, encodeModelToString(model), "utf8");
  return path;
}

const HISTORY_PATH = historyFile();
const MODEL_PATH = modelFile();

function invoke(argv: readonly string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = runSync(argv, io);
  return { io, code };
}

describe("history --report coupling", () => {
  it("ranks the two hand-counted pairs at full confidence", () => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", "coupling", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { total: number; rows: Record<string, unknown>[] };
    expect(parsed.total).toBe(2);
    expect(parsed.rows[0]).toEqual({
      a: HIST.a,
      b: HIST.b,
      support: 3,
      confidence: 1,
      revisionsA: 3,
      revisionsB: 6,
    });
    expect(parsed.rows[1]).toMatchObject({ a: HIST.b, b: HIST.d, support: 3 });
  });

  it("honors the thresholds from the flags", () => {
    const { io, code } = invoke([
      "history", HISTORY_PATH, "--report", "coupling", "--min-support", "4", "--json",
    ]);
    expect(code).toBe(EXIT.OK);
    expect((JSON.parse(io.stdout()) as { total: number }).total).toBe(0);
  });
});

describe("history --report hidden", () => {
  it("keeps only the co-change the declared graph cannot explain", () => {
    const { io, code } = invoke([
      "history", HISTORY_PATH, "--report", "hidden", "--model", MODEL_PATH, "--json",
    ]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { total: number; rows: Record<string, unknown>[] };
    expect(parsed.total).toBe(1);
    expect(parsed.rows[0]).toEqual({
      a: HIST.b,
      b: HIST.d,
      modelA: "com/x/B.java",
      modelB: "com/x/D.java",
      support: 3,
      confidence: 1,
    });
  });

  it("needs a model — a missing one is a usage error naming --model", () => {
    const { io, code } = invoke([
      "history", HISTORY_PATH, "--report", "hidden", "--model", join(scratch, "nowhere.jsonl"),
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--model");
  });
});

describe("history --report deadweight", () => {
  it("reports the declared dependency history never exercised", () => {
    const { io, code } = invoke([
      "history", HISTORY_PATH, "--report", "deadweight", "--model", MODEL_PATH, "--json",
    ]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { total: number; rows: Record<string, unknown>[] };
    expect(parsed.total).toBe(1);
    expect(parsed.rows[0]).toEqual({
      from: "com/x/B.java",
      to: "com/x/C.java",
      edges: 1,
      revisionsFrom: 6,
      revisionsTo: 1,
    });
  });

  it("renders a readable text table too", () => {
    const { io, code } = invoke([
      "history", HISTORY_PATH, "--report", "deadweight", "--model", MODEL_PATH,
    ]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("dead weight of demo");
    expect(io.stdout()).toContain("com/x/B.java -> com/x/C.java");
  });
});
