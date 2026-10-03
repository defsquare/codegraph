import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CityOptions } from "../src/args.js";
import { cityCommand } from "../src/commands/city.js";
import { EXIT, UsageError } from "../src/exit.js";
import { historyMetricsPathFor, loadHistoryJoin } from "../src/history-metrics.js";
import { captureIo } from "../src/io.js";

/**
 * The model and its change-history side-car, joined (PLAN §18.2): the side-car
 * is what `codegraph-metrics --history` wrote over the repository its Rust
 * test builds (fixtures/history-metrics), so every number is hand-countable —
 * Shop.java has 3 commits and 15 lines of churn; the class's blame has 2
 * surviving lines changed in the recent window.
 */
const FIXTURE = (path: string): string => fileURLToPath(new URL(`../../../fixtures/history-metrics/${path}`, import.meta.url));
const MODEL = FIXTURE("model.jsonl");
const SIDECAR = FIXTURE("expected/model.history-metrics.jsonl");

/** The model with its side-car beside it, as `codegraph-metrics --history` leaves them. */
function besideEachOther(): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-history-"));
  const model = join(dir, "shop.jsonl");
  copyFileSync(MODEL, model);
  copyFileSync(SIDECAR, historyMetricsPathFor(model));
  return model;
}

function city(overrides: Partial<CityOptions>): Record<string, number | null> {
  const io = captureIo();
  const options: CityOptions = {
    models: [MODEL],
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
    out: undefined,
    ...overrides,
  };
  expect(cityCommand(options, io)).toBe(EXIT.OK);
  const artifact = JSON.parse(io.stdout()) as { buildings: { id: string; metrics: Record<string, number | null> }[] };
  const shop = artifact.buildings.find((building) => building.id === "java:com.acme/Shop");
  expect(shop).toBeDefined();
  return shop?.metrics ?? {};
}

describe("the change-history side-car, joined to its model", () => {
  it("sits beside the model: X.jsonl → X.history-metrics.jsonl", () => {
    expect(historyMetricsPathFor("/a/b/model.jsonl")).toBe("/a/b/model.history-metrics.jsonl");
  });

  it("joins entities on their rendered natural key and files on the model's path", () => {
    const join = loadHistoryJoin(SIDECAR, []);
    expect(join?.byId.get("java:com.acme/Shop.add(int)")?.["bug_fix_commits"]).toBe(1);
    expect(join?.byFile.get("com/acme/Shop.java")?.["commits_long"]).toBe(3);
    expect(loadHistoryJoin(undefined, [MODEL])).toBeUndefined();
  });

  it("drives the city's channels and carried metrics, read from beside the model", () => {
    const metrics = city({
      models: [besideEachOther()],
      height: "history-file:commits_long",
      footprint: "history-file:churn_long",
      carry: ["history:lines_recent", "history:commits_long"],
    });
    expect(metrics["history-file:commits_long"]).toBe(3);
    expect(metrics["history-file:churn_long"]).toBe(15);
    expect(metrics["history:lines_recent"]).toBe(2);
    expect(metrics["history:commits_long"]).toBe(3);
  });

  it("reads a side-car named by --history-metrics", () => {
    expect(city({ historyMetrics: SIDECAR, carry: ["history:authors_long"] })["history:authors_long"]).toBe(3);
  });

  it("makes a history metric without a side-car, or at the wrong level, a usage error", () => {
    expect(() => city({ height: "history:commits_long" })).toThrow(/side-car/);
    expect(() => city({ historyMetrics: SIDECAR, height: "history:churn_long" })).toThrow(/history-file:churn_long/);
    expect(() => city({ historyMetrics: SIDECAR, height: "history:nope" })).toThrow(UsageError);
    expect(() => city({ historyMetrics: "/nowhere.jsonl" })).toThrow(/no such file/);
  });
});
