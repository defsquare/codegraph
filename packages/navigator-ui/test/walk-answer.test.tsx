import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INSIGHT_ANSWER_KIND as CANONICAL_KIND, WALK_BLOCK_KEYS as CANONICAL_BLOCK_KEYS } from "@codegraph/insights";
import { WalkAnswer } from "../src/components/WalkAnswer.js";
import { WALK_BLOCK_KEYS, parseInsightAnswer, walkFields, type Insight } from "../src/insight.js";

/**
 * A WALK'S BLOCK IN THE NAVIGATE PANEL (PLAN.md §22.5, step 7b). `serve
 * --insights <model>.N.walk.db` answers `insight.json` with the walk's record
 * and its name (`walk`); the panel shows it GENERICALLY — the walk, the answer,
 * every field by its name, the description, the confidence — as an inference,
 * the way explain's reading is shown. It knows no definition: a field is shown
 * by what its value is.
 */

const OP = "java:com.acme.order/OrderService#place(Order)";

const answered = (block: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown => ({
  kind: CANONICAL_KIND, id: OP, status: "explained", walk: "risk",
  record: { t: "i", id: OP, level: "operation", kind: "method", origin: "llm", model: "leaf-served", fingerprint: "a".repeat(64), block },
  ...extra,
});

const BLOCK = {
  answer: "It writes the order\nand never checks the total.",
  boundary: "starts",
  count: 3,
  risky: true,
  safe: false,
  owner: null,
  notes: ["unchecked total", "no lock"],
  steps: [{ line: 12, text: "opens", final: false }],
  none: [],
  description: "Places an order.",
  confidence: 0.7,
};

describe("the walk's block is restated, not imported", () => {
  it("a generic block's own keys are the insights package's, exactly", () => {
    expect([...WALK_BLOCK_KEYS]).toEqual([...CANONICAL_BLOCK_KEYS]);
  });
});

describe("parseInsightAnswer on a walk's answer", () => {
  it("reads the walk, the answer, every field by name in block order, the description and the confidence", () => {
    expect(parseInsightAnswer(answered(BLOCK))).toEqual({
      status: "answered",
      id: OP,
      walk: "risk",
      level: "operation",
      origin: "llm",
      model: "leaf-served",
      confidence: 0.7,
      answer: "It writes the order\nand never checks the total.",
      description: "Places an order.",
      fields: [
        { name: "boundary", value: { kind: "text", text: "starts" } },
        { name: "count", value: { kind: "text", text: "3" } },
        { name: "risky", value: { kind: "text", text: "true" } },
        // An answer of `false` is an answer: kept, never dropped as explain's facts drop it.
        { name: "safe", value: { kind: "text", text: "false" } },
        { name: "owner", value: { kind: "text", text: "—" } },
        { name: "notes", value: { kind: "list", items: [{ kind: "text", text: "unchecked total" }, { kind: "text", text: "no lock" }] } },
        { name: "steps", value: { kind: "list", items: [{ kind: "fields", fields: [{ name: "line", value: { kind: "text", text: "12" } }, { name: "text", value: { kind: "text", text: "opens" } }, { name: "final", value: { kind: "text", text: "false" } }] }] } },
        { name: "none", value: { kind: "list", items: [] } },
      ],
    });
  });

  it("is told from explain's by the data — the `walk` key — never by the block's shape", () => {
    // Explain's block under a walk's name is a walk's; a walk's block without one is explain's reading of it.
    expect(parseInsightAnswer(answered({ name: "place", description: "D.", concept: "aggregate", confidence: 0.5 })).status).toBe("answered");
    const { walk: _walk, ...explainShaped } = answered(BLOCK) as Record<string, unknown>;
    expect(parseInsightAnswer(explainShaped).status).toBe("explained");
    // A `walk` that is no name is nothing to show.
    expect(parseInsightAnswer({ ...(answered(BLOCK) as object), walk: 3 })).toEqual({ status: "none" });
  });

  it("a failure on a walk's store names the walk; explain's names none", () => {
    const failure = { model: "m", attempts: 1, reason: { kind: "provider", status: 400, message: "too long" } };
    expect(parseInsightAnswer({ kind: CANONICAL_KIND, id: OP, status: "failed", walk: "risk", failure })).toEqual({ status: "failed", id: OP, walk: "risk", model: "m", attempts: 1, reason: "provider 400: too long" });
    expect(parseInsightAnswer({ kind: CANONICAL_KIND, id: OP, status: "failed", failure })).toEqual({ status: "failed", id: OP, walk: undefined, model: "m", attempts: 1, reason: "provider 400: too long" });
  });

  it("walkFields reads any object block generically, the block's own keys apart", () => {
    expect(walkFields({ answer: "a", description: "d", confidence: 1, nested: { inner: { deep: "x" } } })).toEqual([
      { name: "nested", value: { kind: "fields", fields: [{ name: "inner", value: { kind: "fields", fields: [{ name: "deep", value: { kind: "text", text: "x" } }] } }] } },
    ]);
    expect(walkFields({ empty: "" })).toEqual([{ name: "empty", value: { kind: "text", text: "—" } }]);
  });
});

describe("WalkAnswer: the panel's walk block", () => {
  /** Rendered per test, so a parse that goes wrong fails each assertion, not the file's collection. */
  function answeredInsight(): Extract<Insight, { status: "answered" }> {
    const insight = parseInsightAnswer(answered(BLOCK));
    if (insight.status !== "answered") throw new Error(`expected a walk's answer, got ${insight.status}`);
    return insight;
  }
  const markup = (): string => renderToStaticMarkup(<WalkAnswer insight={answeredInsight()} />);

  it("wears the inference frame: the badge, the walk's name, the model, the confidence", () => {
    const html = markup();
    expect(html).toMatch(/^<section class="insight insight-walk" aria-label="The walk risk&#x27;s answer, a language model&#x27;s reading">/u);
    expect(html).toContain('<span class="insight-badge">LLM answer</span>');
    expect(html).toContain('<span class="insight-walk-name">walk <strong>risk</strong></span>');
    expect(html).toContain("<span>leaf-served</span>");
    expect(html).toContain("confidence <strong>0.70</strong>");
  });

  it("shows the answer, then every field by its name in order, then the description", () => {
    const html = markup();
    const answer = html.indexOf('<p class="insight-answer">It writes the order\nand never checks the total.</p>');
    const names = ["boundary", "count", "risky", "safe", "owner", "notes", "steps", "none"].map((name) => html.indexOf(`<dt>${name}</dt>`));
    const description = html.indexOf('<p class="insight-text insight-description">Places an order.</p>');
    expect(answer).toBeGreaterThan(0);
    expect(names.every((at) => at > answer)).toBe(true);
    expect([...names].sort((a, b) => a - b)).toEqual(names);
    expect(description).toBeGreaterThan(names[names.length - 1] ?? Infinity);
  });

  it("a value as what it is: text, a list, an object's fields by name, nothing as a dash", () => {
    const html = markup();
    expect(html).toContain("<dt>safe</dt><dd><span>false</span></dd>");
    expect(html).toContain("<dt>owner</dt><dd><span>—</span></dd>");
    expect(html).toContain('<dt>notes</dt><dd><ul class="insight-list"><li><span>unchecked total</span></li><li><span>no lock</span></li></ul></dd>');
    expect(html).toContain('<dt>steps</dt><dd><ul class="insight-list"><li><dl class="insight-nested"><div><dt>line</dt><dd><span>12</span></dd></div>');
    expect(html).toContain("<dt>none</dt><dd><span>—</span></dd>");
  });

  it("a templated record says so instead of naming a model", () => {
    const templated = renderToStaticMarkup(<WalkAnswer insight={{ ...answeredInsight(), origin: "template" }} />);
    expect(templated).toContain('<span class="insight-badge">templated</span>');
    expect(templated).not.toContain("leaf-served");
  });
});
