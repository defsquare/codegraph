import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CityOptions } from "../src/args.js";
import { cityCommand } from "../src/commands/city.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph city` over the committed Spoon output. What is checked here is the
 * COMMAND's contract — stream purity, exit codes, flags reaching the transform,
 * a bad metric being a usage error — not the transform's arithmetic, which is
 * `@codegraph/city`'s own suite.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

function options(overrides: Partial<CityOptions> = {}): CityOptions {
  return {
    models: [FIXTURE],
    height: "loc",
    heightScale: "linear",
    footprint: "members",
    footprintScale: "sqrt",
    carry: [],
    name: undefined,
    framework: undefined,
    internalOnly: false,
    declaredOnly: false,
    layout: false,
    serve: false,
    port: 4177,
    host: "0.0.0.0",
    out: undefined,
    ...overrides,
  };
}

function cityTo(overrides: Partial<CityOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = cityCommand(options(overrides), io);
  return { io, code };
}

interface CityJson {
  kind: string;
  generatedBy: string;
  view: { name: string };
  conventions: { arrowAttachment: string; heightAxis: string };
  bindings: { channel: string; metric: string; scale: string; unmeasured: number }[];
  districts: { id: string; buildings: string[]; footprintDemand: number }[];
  buildings: {
    id: string;
    district: string;
    isStub: boolean;
    height: number;
    footprint: { width: number; depth: number };
    metrics: Record<string, number | null>;
  }[];
  arrows: { from: string; to: string; count: number; inferred: boolean }[];
  diagnostics: { unplacedBuildings: string[] };
}

function parseCity(stdout: string): CityJson {
  return JSON.parse(stdout) as CityJson;
}

describe("city: the artifact", () => {
  it("writes a city model and nothing else on stdout", () => {
    const { io, code } = cityTo();
    expect(code).toBe(EXIT.OK);
    // Stream purity: stdout parses as JSON on its own, byte one to byte last.
    // stderr may carry warnings — that is the point of the split, and the
    // default view leaves stub types the model gives no module for.
    const city = parseCity(io.stdout());
    expect(city.kind).toBe("codegraph.city/1");
    expect(city.generatedBy).toBe("@codegraph/city");
    expect(io.stderr()).not.toContain("codegraph.city/1");
  });

  it("says on stderr which types it could not place, rather than dropping them silently", () => {
    const { io } = cityTo();
    const city = parseCity(io.stdout());
    expect(city.diagnostics.unplacedBuildings.length).toBeGreaterThan(0);
    expect(io.stderr()).toContain("no module");
  });

  it("is a city: districts with buildings, buildings with dimensions, roof-to-roof arrows", () => {
    const city = parseCity(cityTo({ internalOnly: true }).io.stdout());
    expect(city.districts.length).toBeGreaterThan(0);
    expect(city.buildings.length).toBeGreaterThan(city.districts.length);
    expect(city.arrows.length).toBeGreaterThan(0);
    expect(city.conventions.arrowAttachment).toBe("roof");
    for (const building of city.buildings) {
      expect(building.height).toBeGreaterThan(0);
      expect(building.footprint.width).toBeGreaterThan(0);
      // The layout pass has not run: nothing is placed.
      expect(building).not.toHaveProperty("position");
    }
  });

  it("carries the view into the artifact", () => {
    expect(parseCity(cityTo().io.stdout()).view.name).toBe("all");
    expect(parseCity(cityTo({ internalOnly: true }).io.stdout()).view.name).toBe("internalOnly");
  });

  it("is byte-identical across runs", () => {
    expect(cityTo().io.stdout()).toBe(cityTo().io.stdout());
  });
});

describe("city: the flags reach the transform", () => {
  it("binds the metric and scale that were asked for", () => {
    const city = parseCity(
      cityTo({ height: "methods", heightScale: "log", footprint: "fanIn" }).io.stdout(),
    );
    const height = city.bindings.find((binding) => binding.channel === "height");
    expect(height?.metric).toBe("methods");
    expect(height?.scale).toBe("log");
    expect(city.bindings.find((binding) => binding.channel === "footprint")?.metric).toBe("fanIn");
  });

  it("carries extra metrics onto every building without binding them", () => {
    const city = parseCity(cityTo({ carry: ["methods", "fanOut"] }).io.stdout());
    for (const building of city.buildings) {
      expect(Object.keys(building.metrics).sort()).toEqual(["fanOut", "loc", "members", "methods"]);
    }
    // Carrying a metric does not make it a dimension.
    expect(city.bindings.map((binding) => binding.metric).sort()).toEqual(["loc", "members"]);
  });

  it("treats an unknown metric as a usage error naming what exists", () => {
    let error: unknown;
    try {
      cityTo({ height: "complexity" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("unknown metric source: complexity");
    expect((error as UsageError).message).toContain("loc");
  });

  it("builds a city from the extractor's own measures (M10b)", () => {
    const { io, code } = cityTo({ height: "sum:cyclomatic" });
    expect(code).toBe(EXIT.OK);
    const city = parseCity(io.stdout());
    const height = city.bindings.find((binding) => binding.channel === "height");
    expect(height?.metric).toBe("sum:cyclomatic");
    // Every corpus type is measured; a STUB never was — nothing read its source,
    // so it is floored and counted, never drawn as a zero-complexity building.
    const measured = city.buildings.filter((b) => b.metrics["sum:cyclomatic"] !== null);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((building) => !building.isStub)).toBe(true);
    expect(height?.unmeasured).toBe(city.buildings.length - measured.length);
    for (const building of city.buildings) {
      if (building.isStub) expect(building.metrics["sum:cyclomatic"]).toBeNull();
    }
  });

  it("reports a metric no extractor emits as unmeasured, not as zero", () => {
    // The honest answer for a key nothing carries is "unmeasured on every
    // building", not a city of zero-height boxes.
    const { io, code } = cityTo({ height: "sum:halstead" });
    expect(code).toBe(EXIT.OK);
    const city = parseCity(io.stdout());
    const height = city.bindings.find((binding) => binding.channel === "height");
    expect(height?.unmeasured).toBe(city.buildings.length);
    expect(io.stderr()).toContain("unmeasured");
    for (const building of city.buildings) expect(building.metrics["sum:halstead"]).toBeNull();
  });
});

describe("city: --name", () => {
  it("defaults the corpus name to the model root's basename", () => {
    const { io } = cityTo();
    const city = JSON.parse(io.stdout()) as { corpus: { name: string; roots: string[] } };
    // The fixture's header says root: "fixtures/java/src".
    expect(city.corpus.name).toBe("src");
    expect(city.corpus.roots).toEqual(["fixtures/java/src"]);
  });

  it("puts --name in the artifact verbatim", () => {
    const { io } = cityTo({ name: "acme" });
    const city = JSON.parse(io.stdout()) as { corpus: { name: string } };
    expect(city.corpus.name).toBe("acme");
  });

  it("parses from argv through the real dispatcher", () => {
    const io = captureIo();
    const code = run(["city", FIXTURE, "--name", "acme"], io);
    expect(code).toBe(EXIT.OK);
    const city = JSON.parse(io.stdout()) as { corpus: { name: string } };
    expect(city.corpus.name).toBe("acme");
  });
});

describe("city: --out", () => {
  it("writes the artifact to the file and confirms on stderr, leaving stdout empty", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-city-")), "city.json");
    const { io, code } = cityTo({ out: path });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(path);
    expect(io.stderr()).toContain("district");
    // The sink records the write rather than performing it, which is what makes
    // the command testable without a filesystem.
    const written = io.files().get(path);
    expect(written).toBeDefined();
    expect(parseCity(written as string).kind).toBe("codegraph.city/1");
  });
});

describe("city: through the real dispatcher", () => {
  it("runs from argv", () => {
    const io = captureIo();
    const code = run(["city", FIXTURE, "--internal-only", "--carry", "methods"], io);
    expect(code).toBe(EXIT.OK);
    expect(parseCity(io.stdout()).kind).toBe("codegraph.city/1");
  });

  it("rejects an invalid scale before doing any work", () => {
    const io = captureIo();
    const code = run(["city", FIXTURE, "--height-scale", "quadratic"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("--height-scale");
  });

  it("appears in the global help", () => {
    const io = captureIo();
    expect(run(["--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("city");
  });
});

describe("city: --layout", () => {
  it("adds placement — positions, bounds and the declared packer — to the artifact", () => {
    const { io, code } = cityTo({ layout: true });
    expect(code).toBe(EXIT.OK);
    const city = JSON.parse(io.stdout()) as CityJson & {
      layout: { algorithm: string; buildingGap: number };
      bounds: { width: number; depth: number };
      buildings: { position: { x: number; y: number } }[];
      districts: { bounds: { x: number; y: number; width: number; depth: number } }[];
    };
    expect(city.layout.algorithm).toBe("shelf-rows");
    expect(city.bounds.width).toBeGreaterThan(0);
    for (const building of city.buildings) {
      expect(building.position.x).toBeTypeOf("number");
      expect(building.position.y).toBeTypeOf("number");
    }
    for (const district of city.districts) {
      expect(district.bounds.width).toBeGreaterThan(0);
    }
  });

  it("says so in the --out confirmation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-city-")), "city.json");
    const { io } = cityTo({ layout: true, out: path });
    expect(io.stderr()).toContain("laid out");
  });

  it("without the flag, the artifact stays placement-free", () => {
    const { io } = cityTo();
    const city = JSON.parse(io.stdout()) as {
      layout?: unknown;
      buildings: { position?: unknown }[];
    };
    expect(city.layout).toBeUndefined();
    expect(city.buildings.every((building) => building.position === undefined)).toBe(true);
  });

  it("runs from argv through the real dispatcher", () => {
    const io = captureIo();
    const code = run(["city", FIXTURE, "--internal-only", "--layout"], io);
    expect(code).toBe(EXIT.OK);
    const city = JSON.parse(io.stdout()) as { layout: { algorithm: string } };
    expect(city.layout.algorithm).toBe("shelf-rows");
  });
});

describe("city --serve", () => {
  interface StartedServer {
    artifact: string;
    assets: string;
    port: number;
    host: string | undefined;
  }

  /** The seam: no sockets, no built viz — just what the command handed over. */
  function serveTo(overrides: Partial<CityOptions> = {}) {
    const io = captureIo();
    const started: StartedServer[] = [];
    const code = cityCommand(options({ serve: true, ...overrides }), io, {
      assetsDir: () => "/fake/viz/dist",
      startServer: (serverOptions) => {
        started.push({
          artifact: serverOptions.artifact,
          assets: serverOptions.assets,
          port: serverOptions.port,
          host: serverOptions.host,
        });
        return undefined;
      },
    });
    return { io, code, started };
  }

  it("hands the server a LAID-OUT artifact even without --layout", () => {
    const { code, started } = serveTo();
    expect(code).toBe(EXIT.OK);
    expect(started).toHaveLength(1);
    const city = JSON.parse(started[0]?.artifact ?? "") as {
      layout: { algorithm: string };
      buildings: { position?: unknown }[];
    };
    expect(city.layout.algorithm).toBe("shelf-rows");
    expect(city.buildings.every((building) => building.position !== undefined)).toBe(true);
  });

  it("keeps stdout empty: the server is the artifact's destination", () => {
    const { io } = serveTo();
    expect(io.stdout()).toBe("");
  });

  it("still writes --out alongside serving, with the confirmation on stderr", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-serve-")), "city.json");
    const { io, started } = serveTo({ out: path });
    expect(io.files().get(path)).toBe(started[0]?.artifact);
    expect(io.stderr()).toContain("laid out");
  });

  it("passes the requested port through", () => {
    const { started } = serveTo({ port: 0 });
    expect(started[0]?.port).toBe(0);
  });

  it("passes the requested host through", () => {
    const { started } = serveTo({ host: "127.0.0.1" });
    expect(started[0]?.host).toBe("127.0.0.1");
  });

  it("fails BEFORE loading models when the visualizer is not built", () => {
    const io = captureIo();
    expect(() =>
      cityCommand(options({ serve: true, models: ["/nonexistent.jsonl"] }), io, {
        assetsDir: () => {
          throw new UsageError("the visualizer is not built", "Run pnpm -r build.");
        },
        startServer: () => undefined,
      }),
    ).toThrow(UsageError);
  });
});
