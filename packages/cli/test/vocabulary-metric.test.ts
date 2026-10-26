import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "@codegraph/analyzer";
import type { MetricContext } from "@codegraph/city";
import { buildVocabulary, type VocabularyArtifact } from "@codegraph/vocabulary";
import type { CityOptions } from "../src/args.js";
import { cityCommand, cityOf } from "../src/commands/city.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { loadModelFiles } from "../src/load.js";
import { vocabularyMetric } from "../src/vocabulary-metric.js";

/**
 * The city's vocabulary channel (PLAN.md §20.2): `vocabulary:<word>` measures
 * a building by the word's weight in its type's names — the Vocabulary tab's
 * type scope, so the tab and the city read one number. The Java fixture's
 * `order` is counted by hand in fixtures/java/README.md: `Order` and
 * `AbstractOrder` are their class names (8 each); `OrderService` is its name,
 * `bill`'s parameter and `archive`'s local (8 + 1 + 1); `Notifications` is
 * four `order` parameters (4 × 1).
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

interface Building {
  readonly id: string;
  readonly isStub: boolean;
  readonly metrics: Record<string, number | null>;
}

interface CityJson {
  readonly bindings: { channel: string; metric: string; unit: string; describe: string; unmeasured: number }[];
  readonly buildings: Building[];
}

function cityOptions(overrides: Partial<CityOptions> = {}): CityOptions {
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
    out: undefined,
    ...overrides,
  };
}

function city(overrides: Partial<CityOptions>): { json: CityJson; stderr: string } {
  const io = captureIo();
  expect(cityCommand(cityOptions(overrides), io)).toBe(EXIT.OK);
  return { json: JSON.parse(io.stdout()) as CityJson, stderr: io.stderr() };
}

/** The corpus's buildings that measure above zero, by short name. */
function spoken(json: CityJson, metric: string): Record<string, number | null | undefined> {
  return Object.fromEntries(
    json.buildings
      .filter((building) => !building.isStub && building.metrics[metric] !== 0)
      .map((building) => [building.id.slice(building.id.indexOf("/") + 1), building.metrics[metric]]),
  );
}

describe("vocabulary:<word>, the city's vocabulary channel", () => {
  it("measures a building by the word's weight in its type's names, the counting the fixture's README does by hand", () => {
    const { json } = city({ height: "vocabulary:order" });
    expect(spoken(json, "vocabulary:order")).toEqual({ AbstractOrder: 8, Notifications: 4, Order: 8, OrderService: 10 });
    const height = json.bindings.find((binding) => binding.channel === "height");
    expect(height?.metric).toBe("vocabulary:order");
    expect(height?.unit).toBe("weighted occurrences");
    expect(height?.describe).toContain("order");
  });

  // A type whose names never say the word was read and weighs 0: a measured
  // zero, not a missing measurement.
  it("weighs 0 on a type whose names never say it, and leaves a stub unmeasured", () => {
    const { json, stderr } = city({ height: "vocabulary:order" });
    const corpus = json.buildings.filter((building) => !building.isStub);
    const stubs = json.buildings.filter((building) => building.isStub);
    expect(corpus.filter((building) => building.metrics["vocabulary:order"] === 0)).toHaveLength(corpus.length - 4);
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) expect(stub.metrics["vocabulary:order"], stub.id).toBeNull();
    expect(json.bindings.find((binding) => binding.channel === "height")?.unmeasured).toBe(stubs.length);
    expect(stderr).toContain(`height is unmeasured on ${stubs.length} buildings (metric vocabulary:order)`);
    expect(city({ height: "vocabulary:order", internalOnly: true }).json.bindings[0]?.unmeasured).toBe(0);
  });

  it("drives the footprint and the carried metrics too", () => {
    const { json } = city({ footprint: "vocabulary:order", carry: ["vocabulary:basket"] });
    expect(spoken(json, "vocabulary:order")).toEqual({ AbstractOrder: 8, Notifications: 4, Order: 8, OrderService: 10 });
    expect(spoken(json, "vocabulary:basket")["Basket"]).toBeGreaterThan(0);
  });

  it("reads the word as the splitter reads a name: case folded, one word", () => {
    expect(spoken(city({ height: "vocabulary:Order" }).json, "vocabulary:Order")).toEqual({
      AbstractOrder: 8,
      Notifications: 4,
      Order: 8,
      OrderService: 10,
    });
    expect(() => city({ height: "vocabulary:OrderService" })).toThrow(/2 words \(order, service\)/);
    expect(() => city({ height: "vocabulary:" })).toThrow(UsageError);
    expect(() => city({ height: "vocabulary:42" })).toThrow(UsageError);
  });

  // A typo would otherwise draw a flat city that looks like an answer.
  it("refuses a word no name in the view says", () => {
    expect(() => city({ height: "vocabulary:zebra" })).toThrow(/no name in view all says "zebra"/);
  });

  it("reads the artifact a caller hands in rather than counting again", () => {
    const graph = buildGraph(loadModelFiles([FIXTURE]).union);
    const counted = buildVocabulary(graph);
    const order = counted.terms.findIndex((term) => term.text === "order");
    const doctored: VocabularyArtifact = {
      ...counted,
      scopes: counted.scopes.map((scope) =>
        scope.id === "java:com.acme.order/Money" ? { ...scope, terms: [[order, 99, 1, 1]] } : scope,
      ),
    };
    const built = cityOf(graph, { ...cityOptions(), height: "vocabulary:order" }, undefined, doctored);
    expect(built.buildings.find((building) => building.id === "java:com.acme.order/Money")?.metrics["vocabulary:order"]).toBe(99);
  });

  it("counts nothing unless a vocabulary: metric is named", () => {
    const never = (): VocabularyArtifact => {
      throw new Error("counted");
    };
    expect(vocabularyMetric("loc", never)).toBeUndefined();
    expect(vocabularyMetric("history:commits_long", never)).toBeUndefined();
  });
});

describe("vocabularyMetric over an artifact", () => {
  const ROLES = { module: 0, type: 0, operation: 0, attribute: 0, parameter: 0, local: 0, other: 0 };
  const scope = (id: string, terms: [number, number, number, number][]) => ({
    level: "type" as const,
    id,
    name: id,
    kind: "class",
    parent: 0,
    entities: 1,
    roles: ROLES,
    skipped: { unnamed: 0, conventional: 0, numeric: 0 },
    distinct: terms.length,
    distinctDomain: 0,
    weight: 0,
    occurrences: 0,
    terms,
  });
  const artifact = {
    kind: "codegraph.vocabulary/1",
    terms: [
      { text: "final", class: "domain", modules: 1, types: 1 },
      { text: "final", class: "keyword", modules: 1, types: 1 },
      { text: "ledger", class: "domain", modules: 1, types: 1 },
    ],
    scopes: [
      { level: "corpus", name: "mixed", terms: [] },
      scope("cobol:FINAL", [
        [0, 8, 1, 1],
        [1, 3, 1, 1],
      ]),
      scope("cobol:LEDGER", [[2, 8, 1, 1]]),
    ],
    view: { name: "all", filters: [] },
  } as unknown as VocabularyArtifact;
  const at = (id: string): MetricContext => ({ node: { id } }) as unknown as MetricContext;

  // The metric is about the word on the building, not the class a language
  // gives it: two classes of one text add up.
  it("adds up a text two languages class apart", () => {
    const source = vocabularyMetric("vocabulary:final", () => artifact);
    expect(source?.value(at("cobol:FINAL"))).toBe(11);
    expect(source?.value(at("cobol:LEDGER"))).toBe(0);
    expect(source?.value(at("java:Unread"))).toBeUndefined();
  });
});
