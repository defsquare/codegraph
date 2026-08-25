import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Entity, type Model } from "@codegraph/core";
import type { ReplayCityLayout } from "@codegraph/city";

import type { ReplayOptions } from "../src/args.js";
import { replayCommand, type ServeDeps } from "../src/commands/replay.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

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
  const code = run(argv, io);
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

    // Hand-counted series against the union domain [0, 35] -> [1, 40].
    expect(city.replay.series[id("A")]).toEqual([[0, 23.286], [1, 40], [2, 34.429]]);
    expect(city.replay.series[id("B")]).toEqual([[0, 12.143], [1, 0]]);
    expect(city.replay.series[id("C")]).toEqual([[1, 6.571], [2, 9.914]]);
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
      store: storePath, name: undefined, out: undefined,
      serve: true, port: 0, host: "127.0.0.1",
    };
    const io = captureIo();
    expect(replayCommand(options, io, deps)).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(served).toHaveLength(1);
    expect((JSON.parse(served[0] ?? "") as ReplayCityLayout).replay.clock).toBe("revisions");
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
