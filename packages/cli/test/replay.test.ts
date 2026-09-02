import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Entity, type Model } from "@codegraph/core";
import type { ReplayCityLayout } from "@codegraph/city";
import { HISTORY_SCHEMA_VERSION, encodeHistoryToString, type History } from "@codegraph/scm";

import type { ReplayOptions } from "../src/args.js";
import { replayCommand, type ServeDeps } from "../src/commands/replay.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `codegraph replay` (M9c): the temporal store from the same three-revision
 * story as the timeline suite, rendered as ONE laid-out replay city.
 *
 *   rev a (t=1000)  A 20   B 10      rev b (t=2000)  A 35   C 5
 *   rev c (t=3000)  A 30   C 8
 *
 * Union domain [0, 35] linear into [1, 40]: 20 → 23.286 · 35 → 40 ·
 * 30 → 34.429 · 10 → 12.143 · 5 → 6.571 · 8 → 9.914.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-replay-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40) } as const;
const storePath = join(scratch, "story.db");

const moduleId = renderId({ lang: "java", module: "app", symbol: "" });
const id = (symbol: string): string => renderId({ lang: "java", module: "app", symbol });

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
  const code = runSync(argv, io);
  return { io, code };
}

function buildStore(): void {
  const revisions: [string, [string, number][], string][] = [
    [SHA.a, [["A", 20], ["B", 10]], "1000"],
    [SHA.b, [["A", 35], ["C", 5]], "2000"],
    [SHA.c, [["A", 30], ["C", 8]], "3000"],
  ];
  for (const [index, [sha, types, time]] of revisions.entries()) {
    const { code } = invoke([
      "import", snapshot(`rev-${index}`, types),
      "--at", sha, "--time", time, "--out", storePath,
    ]);
    expect(code).toBe(EXIT.OK);
  }
}
buildStore();

describe("codegraph replay", () => {
  it("prints one laid-out replay city artifact on stdout", () => {
    const { io, code } = invoke(["replay", "--store", storePath, "--name", "story"]);
    expect(code).toBe(EXIT.OK);
    const city = JSON.parse(io.stdout()) as ReplayCityLayout;

    expect(city.kind).toBe("codegraph.city/1");
    expect(city.corpus.name).toBe("story");
    expect(city.replay.clock).toBe("revisions");
    expect(city.replay.ticks.map((tick) => tick.hash)).toEqual([SHA.a, SHA.b, SHA.c]);

    expect(city.buildings.map((building) => building.id).sort()).toEqual(
      [id("A"), id("B"), id("C")].sort(),
    );
    // Frozen plots for every type that ever existed — B is dead yet placed.
    expect(city.buildings.every((building) => typeof building.position?.x === "number")).toBe(true);
    const b = city.buildings.find((building) => building.id === id("B"));
    expect(b?.height).toBe(0);

    // Hand-counted series against the union domain [0, 35] -> [1, 40];
    // every LOC move is a change, so heat is 1 while alive, 0 at death.
    expect(city.replay.series[id("A")]).toEqual([[0, 23.286, 1], [1, 40, 1], [2, 34.429, 1]]);
    expect(city.replay.series[id("B")]).toEqual([[0, 12.143, 1], [1, 0, 0]]);
    expect(city.replay.series[id("C")]).toEqual([[1, 6.571, 1], [2, 9.914, 1]]);
  });

  it("--out writes the artifact and keeps stdout empty", () => {
    const out = join(scratch, "replay-city.json");
    const { io, code } = invoke(["replay", "--store", storePath, "--out", out]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    const city = JSON.parse(io.files().get(out) ?? "") as ReplayCityLayout;
    expect(city.replay.ticks).toHaveLength(3);
    // The default name is the store's basename.
    expect(city.corpus.name).toBe("story");
    expect(io.stderr()).toContain("3 buildings");
  });

  it("--serve hands the artifact to the server seam, stdout stays empty", () => {
    const served: string[] = [];
    const deps: ServeDeps = {
      assetsDir: () => scratch,
      startServer: (serverOptions) => served.push(serverOptions.artifact),
    };
    const options: ReplayOptions = {
      store: storePath, name: undefined, history: undefined, out: undefined,
      serve: true, port: 0, host: "127.0.0.1",
    };
    const io = captureIo();
    expect(replayCommand(options, io, deps)).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(served).toHaveLength(1);
    expect((JSON.parse(served[0] ?? "") as ReplayCityLayout).replay.clock).toBe("revisions");
  });

  it("--history joins owners and co-change arcs by path suffix", () => {
    // Repo paths sit ABOVE the model's anchor paths: the suffix join maps
    // repo/app/A.java -> app/A.java. Three commits touch A and C together
    // (support 3, confidence 1 at the default thresholds); alice owns all.
    const commit = (n: number) => ({
      hash: String(n).repeat(40), author: 0, time: 1000 * (n + 1), isFix: false, isRevert: false,
    });
    const mined: History = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      scm: "git",
      miner: "test",
      repo: "demo",
      authors: ["alice <a@x>"],
      paths: ["repo/app/A.java", "repo/app/C.java"],
      commits: [commit(0), commit(1), commit(2)],
      changes: [0, 1, 2].flatMap((c) => [
        { commit: c, path: 0, added: 5, deleted: 0 },
        { commit: c, path: 1, added: 2, deleted: 0 },
      ]),
    };
    const historyPath = join(scratch, "mined-history.jsonl");
    writeFileSync(historyPath, encodeHistoryToString(mined), "utf8");

    const { io, code } = invoke(["replay", "--store", storePath, "--history", historyPath]);
    expect(code).toBe(EXIT.OK);
    expect(io.stderr()).toContain("joined");
    const city = JSON.parse(io.stdout()) as ReplayCityLayout;
    const a = city.buildings.find((building) => building.id === id("A"));
    expect(a?.owner).toEqual({ name: "alice <a@x>", share: 1 });
    expect(city.buildings.find((building) => building.id === id("B"))?.owner).toBeUndefined();
    expect(city.replay.coChange).toEqual([
      { a: id("A"), b: id("C"), support: 3, confidence: 1 },
    ]);
  });

  it("refuses an unreadable --history", () => {
    const { code, io } = invoke([
      "replay", "--store", storePath, "--history", join(scratch, "no-history.jsonl"),
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("codegraph scm");
  });

  it("refuses a missing store, naming how to build one", () => {
    const { io, code } = invoke(["replay", "--store", join(scratch, "nowhere.db")]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("snapshots");
  });

  it("refuses a plain single-model cache — no revisions to scrub", () => {
    const flat = join(scratch, "flat.db");
    expect(invoke(["import", snapshot("flat", [["A", 1]]), "--out", flat]).code).toBe(EXIT.OK);
    const { io, code } = invoke(["replay", "--store", flat]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("holds no revisions");
  });
});
