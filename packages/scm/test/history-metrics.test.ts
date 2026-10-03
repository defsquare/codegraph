import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HISTORY_MEASURES,
  HISTORY_METRICS_KIND,
  HistoryMetricsError,
  decodeHistoryMetricsText,
  encodeHistoryMetrics,
  type HistoryMetrics,
} from "../src/history-metrics.js";

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** Written by `codegraph-metrics --history` over the repository its Rust test builds. */
const FIXTURE = repo("fixtures/history-metrics/expected/model.history-metrics.jsonl");

describe("the history-metrics side-car", () => {
  it("decodes what codegraph-metrics wrote and re-encodes it to the same bytes", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const decoded = decodeHistoryMetricsText(text);
    expect(decoded.header.kind).toBe(HISTORY_METRICS_KIND);
    expect(decoded.files.map((f) => f.path)).toEqual(["com/acme/Shop.java"]);
    expect(decoded.entities.map((e) => e.key.symbol)).toEqual(["Shop", "Shop.add(int)", "Shop.sub(int)"]);
    expect(encodeHistoryMetrics(decoded)).toBe(text);
  });

  it("carries the counts its Rust test derives by hand", () => {
    const { files, entities } = decodeHistoryMetricsText(readFileSync(FIXTURE, "utf8"));
    expect(files[0]?.vcs["commits_long"]).toBe(3);
    expect(files[0]?.vcs["churn_long"]).toBe(15);
    const add = entities.find((e) => e.key.symbol === "Shop.add(int)");
    expect(add?.vcs["lines_long"]).toBe(3);
    expect(add?.vcs["bug_fix_commits"]).toBe(1);
  });

  describe("refuses", () => {
    const lines = (): string[] => readFileSync(FIXTURE, "utf8").trimEnd().split("\n");
    const decode = (text: string[]): HistoryMetrics => decodeHistoryMetricsText(`${text.join("\n")}\n`);

    it("a truncated file (no eof)", () => {
      expect(() => decode(lines().slice(0, -1))).toThrow(/truncated/);
    });
    it("a trailer whose counts disagree", () => {
      const text = lines();
      text[text.length - 1] = JSON.stringify({ t: "eof", counts: { files: 1, entities: 9 } });
      expect(() => decode(text)).toThrow(HistoryMetricsError);
    });
    it("entities out of canonical order", () => {
      const text = lines();
      [text[2], text[3]] = [text[3] as string, text[2] as string];
      expect(() => decode(text)).toThrow(/out of order/);
    });
    it("a model, or anything else without the header first", () => {
      expect(() => decode(['{"t":"header","schemaVersion":"1.0.0"}'])).toThrow(HistoryMetricsError);
      expect(() => decode(lines().slice(1))).toThrow(/no header/);
    });
    it("a measure that is not a number", () => {
      const text = lines();
      text[1] = (text[1] as string).replace('"commits_long":3', '"commits_long":"3"');
      expect(() => decode(text)).toThrow(HistoryMetricsError);
    });
  });

  it("re-encodes any decodable side-car to the bytes it was decoded from (canonical order is the encoder's)", () => {
    const measures = fc.dictionary(fc.constantFrom(...Object.keys(HISTORY_MEASURES)), fc.nat({ max: 10_000 }));
    const key = fc.record(
      { module: fc.string({ maxLength: 6 }), symbol: fc.string({ maxLength: 6 }), disambiguator: fc.option(fc.string({ maxLength: 4 }), { nil: undefined }) },
      { requiredKeys: ["module", "symbol"] },
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 6 }),
        fc.uniqueArray(key, { maxLength: 6, selector: (k) => JSON.stringify([k.module, k.symbol, k.disambiguator ?? null]) }),
        fc.array(measures, { minLength: 12, maxLength: 12 }),
        (paths, keys, values) => {
          const metrics: HistoryMetrics = {
            header: {
              kind: HISTORY_METRICS_KIND,
              generatedBy: { name: "codegraph-metrics", version: "0", bigCodeAnalysis: "0" },
              lang: "java",
              commit: "a".repeat(40),
              asOf: 1,
              windowDays: { long: 365, recent: 90 },
            },
            files: paths.map((path, i) => ({ path, vcs: values[i] ?? {} })),
            entities: keys.map((k, i) => ({ key: { lang: "java", ...k }, vcs: values[6 + i] ?? {} })),
          };
          const text = encodeHistoryMetrics(metrics);
          expect(encodeHistoryMetrics(decodeHistoryMetricsText(text))).toBe(text);
        },
      ),
    );
  });

  it("documents exactly the measures codegraph-metrics writes, at the level it writes them", () => {
    const source = readFileSync(repo("extractors/metrics/src/history.rs"), "utf8");
    const keysOf = (fn: string): string[] => {
      const body = new RegExp(`fn ${fn}\\(s: &Stats\\)[^]*?\\n\\}`).exec(source)?.[0] ?? "";
      return [...body.matchAll(/\("([a-z_]+)",/g)].map((m) => m[1] as string);
    };
    const at = (level: "file" | "entity"): string[] =>
      Object.entries(HISTORY_MEASURES)
        .filter(([, measure]) => measure.levels.includes(level))
        .map(([name]) => name);
    expect(keysOf("file_values")).toEqual(at("file"));
    expect(keysOf("entity_values")).toEqual(at("entity"));
  });
});
