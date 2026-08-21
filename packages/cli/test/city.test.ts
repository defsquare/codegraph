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
    internalOnly: false,
    declaredOnly: false,
    layout: false,
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

  it("accepts an extractor-supplied key today, and reports it unmeasured", () => {
    // Nothing in the Java fixture carries `cyclomatic`; the honest answer is
    // "unmeasured on every building", not a city of zero-height boxes.
    const { io, code } = cityTo({ height: "sum:cyclomatic" });
    expect(code).toBe(EXIT.OK);
    const city = parseCity(io.stdout());
    const height = city.bindings.find((binding) => binding.channel === "height");
    expect(height?.metric).toBe("sum:cyclomatic");
    expect(height?.unmeasured).toBe(city.buildings.length);
    expect(io.stderr()).toContain("unmeasured");
    for (const building of city.buildings) expect(building.metrics["sum:cyclomatic"]).toBeNull();
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
