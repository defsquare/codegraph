import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Entity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { validateModel, type Profile } from "../src/profile.js";
import { csharpProfile } from "../src/profiles/csharp.js";
import { elixirProfile } from "../src/profiles/elixir.js";
import { javaProfile } from "../src/profiles/java.js";
import { rubyProfile } from "../src/profiles/ruby.js";
import { typescriptProfile } from "../src/profiles/typescript.js";

/**
 * THE M17a GATE — `codegraph-metrics` (extractors/metrics, PLAN.md §18), the
 * big-code-analysis pass, over the five fixture models. Its own tests prove it
 * reproduces `model.metrics.jsonl` byte for byte; what only this side can say
 * is that the result is a model core itself would write, that nothing moved
 * but the measures, and that the extractor's own measures survived untouched.
 */

/** The keys the pass writes (METAMODEL.md §3.8), restated and pinned below. */
const MEASURES = [
  "abc.assignments",
  "abc.branches",
  "abc.conditions",
  "abc.magnitude",
  "cloc",
  "cognitive",
  "halstead.difficulty",
  "halstead.effort",
  "halstead.volume",
  "lloc",
  "mi",
  "nexits",
  "npa",
  "npm",
];

/** The subset that counts something, so is a whole number. */
const COUNTS = new Set(["abc.assignments", "abc.branches", "abc.conditions", "cloc", "cognitive", "lloc", "nexits", "npa", "npm"]);

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/**
 * How many measured entities each fixture joins (the pass's stderr summary).
 * The rest have no space of their own — implicit constructors anchored on
 * their class, Java lambdas (big-code-analysis opens none), body-less
 * declarations, Elixir protocols and impls, a Ruby `Struct.new do … end` or
 * `class_methods do … end` — and carry none of the keys.
 */
const FIXTURES: ReadonlyArray<{ lang: string; profile: Profile; joined: number }> = [
  { lang: "java", profile: javaProfile, joined: 70 },
  { lang: "csharp", profile: csharpProfile, joined: 101 },
  { lang: "typescript", profile: typescriptProfile, joined: 89 },
  { lang: "elixir", profile: elixirProfile, joined: 96 },
  { lang: "ruby", profile: rubyProfile, joined: 106 },
];

const metricsOf = (entity: Entity): Record<string, number> | undefined =>
  (entity as Record<string, unknown>)["metrics"] as Record<string, number> | undefined;

function withoutMeasures(model: Model): unknown {
  return {
    ...model,
    entities: model.entities.map((entity) => {
      const { metrics: _metrics, ...rest } = entity as Record<string, unknown>;
      return rest;
    }),
  };
}

describe.each(FIXTURES)("fixtures/$lang/expected/model.metrics.jsonl", ({ lang, profile, joined }) => {
  const path = repo(`fixtures/${lang}/expected/model.metrics.jsonl`);
  const enriched = (): Model => parseModel(readModelFileSync(path));
  const base = (): Model => parseModel(readModelFileSync(repo(`fixtures/${lang}/expected/model.jsonl`)));

  it("is byte-identical to what core's own encoder would write — numbers and key order included", () => {
    expect(encodeModelToString(enriched())).toBe(readFileSync(path, "utf8"));
  });

  it("validates against its profile with ZERO issues", () => {
    const issues = validateModel(enriched(), profile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("differs from the extractor's model in measures alone, keeping every one of the extractor's", () => {
    const [before, after] = [base(), enriched()];
    expect(withoutMeasures(after)).toEqual(withoutMeasures(before));
    let measured = 0;
    after.entities.forEach((entity, i) => {
      const [was, is] = [metricsOf(before.entities[i] as Entity), metricsOf(entity)];
      for (const [key, value] of Object.entries(was ?? {})) expect(is?.[key], `${entity.id} ${key}`).toBe(value);
      const added = Object.keys(is ?? {}).filter((key) => !(was !== undefined && key in was));
      for (const key of added) expect(MEASURES, `${entity.id} ${key}`).toContain(key);
      if (added.length > 0) measured += 1;
    });
    expect(measured).toBe(joined);
  });

  it("measures finite, non-negative numbers: counts whole, mi within 0..100", () => {
    for (const entity of enriched().entities) {
      for (const [key, value] of Object.entries(metricsOf(entity) ?? {})) {
        if (!MEASURES.includes(key)) continue;
        const where = `${entity.id} ${key}`;
        expect(Number.isFinite(value), where).toBe(true);
        expect(value, where).toBeGreaterThanOrEqual(0);
        if (COUNTS.has(key)) expect(Number.isInteger(value), where).toBe(true);
        if (key === "mi") expect(value, where).toBeLessThanOrEqual(100);
      }
    }
  });
});

/**
 * HAND-COUNTED from the fixture sources. Cognitive complexity (Campbell, 2018):
 * +1 per `if`/loop/`catch`/`case`, plus the nesting level it sits at, plus 1
 * per run of `&&`/`||`/`??`. The same `max` algorithm written in three
 * languages scores the same:
 *
 *   max               for +1, nested if +2, `||` (Java, C#) / `??` (TS) +1   = 4
 *   ensure (Java)     if +1, catch +1                                          = 2, 2 throws
 *   ensure (TS)       if +1, catch +1, if nested in the catch +2               = 4, 3 throws + 1 return
 *   available? (ex)   case +1                                                  = 1
 *   total (rb)        `return … if …` +1                                       = 1, 1 return
 *
 * Java `max` is also ABC-counted: assignments `best = null`, `best = value`;
 * one branch (the `compareTo` call); conditions `== null`, `> 0` — √(4+1+4) = 3;
 * five statements (`lloc`).
 */
describe("hand-counted measures", () => {
  const measure = (lang: string, id: string, key: string): number | undefined => {
    const model = readModelFileSync(repo(`fixtures/${lang}/expected/model.metrics.jsonl`));
    const entity = model.entities.find((candidate) => candidate.id === id);
    expect(entity, id).toBeDefined();
    return metricsOf(entity as Entity)?.[key];
  };

  it("Java Reporting.max and StockGuard.ensure", () => {
    const max = "java:com.acme.order/Reporting.max(java.util.List)";
    expect(measure("java", max, "cognitive")).toBe(4);
    expect(measure("java", max, "nexits")).toBe(1);
    expect(measure("java", max, "abc.assignments")).toBe(2);
    expect(measure("java", max, "abc.branches")).toBe(1);
    expect(measure("java", max, "abc.conditions")).toBe(2);
    expect(measure("java", max, "abc.magnitude")).toBe(3);
    expect(measure("java", max, "lloc")).toBe(5);
    expect(measure("java", "java:com.acme.order/StockGuard.ensure(int)", "cognitive")).toBe(2);
    expect(measure("java", "java:com.acme.order/StockGuard.ensure(int)", "nexits")).toBe(2);
  });

  it("C# Reporting.Max", () => {
    const max = "csharp:Acme.Order/Reporting.Max`1(System.Collections.Generic.List`1<!!0>)";
    expect(measure("csharp", max, "cognitive")).toBe(4);
    expect(measure("csharp", max, "nexits")).toBe(1);
  });

  it("TypeScript Report.max and ensure", () => {
    expect(measure("typescript", "ts:packages%2Forder%2Fsrc%2Fdecorators.ts/Report.max", "cognitive")).toBe(4);
    const ensure = "ts:packages%2Forder%2Fsrc%2Freporting.ts/ensure";
    expect(measure("typescript", ensure, "cognitive")).toBe(4);
    expect(measure("typescript", ensure, "nexits")).toBe(4);
  });

  it("Elixir Stock.available?", () => {
    expect(measure("elixir", "ex:lib%2Facme_order%2Fstock.ex/AcmeOrder%2EStock.available?#1", "cognitive")).toBe(1);
  });

  // `return Money.zero(@currency) if @lines.empty?` then `@pricing.price_for(self)`:
  // one branch, one return, no assignment, three calls, one condition.
  it("Ruby Order.total", () => {
    const total = "rb:lib%2Facme_order%2Forder.rb/AcmeOrder::Order.total";
    expect(measure("ruby", total, "cognitive")).toBe(1);
    expect(measure("ruby", total, "nexits")).toBe(1);
    expect(measure("ruby", total, "abc.assignments")).toBe(0);
    expect(measure("ruby", total, "abc.branches")).toBe(3);
    expect(measure("ruby", total, "abc.conditions")).toBe(1);
    // The extractor's own two measures ride through the pass untouched.
    expect(measure("ruby", total, "cyclomatic")).toBe(2);
    expect(measure("ruby", total, "sloc")).toBe(4);
  });
});

describe("the measure vocabulary", () => {
  it("is exactly the key list extractors/metrics writes", () => {
    const source = readFileSync(repo("extractors/metrics/src/join.rs"), "utf8");
    const list = /pub const KEYS: &\[&str\] = &\[([^\]]*)\]/.exec(source)?.[1];
    expect(list, "KEYS in join.rs").toBeDefined();
    const keys = [...(list ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(keys).toEqual(MEASURES);
  });

  it("is documented, key by key, in METAMODEL.md §3.8", () => {
    const metamodel = readFileSync(repo("METAMODEL.md"), "utf8");
    const section = metamodel.slice(metamodel.indexOf("### 3.8 Measures"), metamodel.indexOf("## 4. Edges"));
    for (const key of MEASURES) expect(section, key).toContain(`\`${key}\``);
  });
});
