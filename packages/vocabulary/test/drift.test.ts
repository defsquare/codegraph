import { fileURLToPath } from "node:url";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadModels } from "@codegraph/analyzer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import type { VocabularyArtifact } from "../src/artifact.js";
import { parseBusinessTerms, vocabularyDrift, type BusinessTerm, type DriftReport } from "../src/drift.js";
import { graphOf, orderCorpus } from "./toy.js";

/**
 * Drift (PLAN.md §20.1): a business glossary against the words the code
 * speaks. A business term is SPOKEN in a scope when every one of its words is;
 * the code's own `domain` words no business term contains are the other half.
 */

const toy = buildVocabulary(graphOf([{ lang: "java", entities: orderCorpus() }]));
const terms = (...lines: string[]): readonly BusinessTerm[] => parseBusinessTerms(lines.join("\n")).terms;

/** `[text, scopes, missing]` per business term; `[word, weight, occurrences, scopes]` per code-only word. */
function summary(artifact: VocabularyArtifact, report: DriftReport) {
  return {
    business: report.business.map(({ text, scopes, missing }) => [text, scopes, missing]),
    codeOnly: report.codeOnly.map(({ term, weight, occurrences, scopes }) => [
      artifact.terms[term]?.text,
      weight,
      occurrences,
      scopes,
    ]),
  };
}

describe("parseBusinessTerms", () => {
  it("reads one term per line, split by the universal rules", () => {
    expect(parseBusinessTerms("Order\nOrder Line\nbon de commande\nHTTPServer\n").terms).toEqual([
      { text: "Order", words: ["order"] },
      { text: "Order Line", words: ["order", "line"] },
      { text: "bon de commande", words: ["bon", "de", "commande"] },
      { text: "HTTPServer", words: ["http", "server"] },
    ]);
  });

  it("skips blank lines and # comments, and trims every line", () => {
    expect(parseBusinessTerms("# the glossary\n\n  Order Line  \r\n\t\n#Customer\n").terms).toEqual([
      { text: "Order Line", words: ["order", "line"] },
    ]);
  });

  it("keeps the first spelling of a term whose words repeat an earlier one's", () => {
    expect(parseBusinessTerms("Order Line\norder-line\nORDER_LINE\nLine Order\nOrder Order\n").terms).toEqual([
      { text: "Order Line", words: ["order", "line"] },
      { text: "Line Order", words: ["line", "order"] },
      { text: "Order Order", words: ["order"] },
    ]);
  });

  it("reports a line that names no word, by its line number", () => {
    expect(parseBusinessTerms("Order\n2024\n— —\nForm 1099\n")).toEqual({
      terms: [
        { text: "Order", words: ["order"] },
        { text: "Form 1099", words: ["form"] },
      ],
      wordless: [
        { line: 2, text: "2024" },
        { line: 3, text: "— —" },
      ],
    });
  });
});

describe("vocabularyDrift on the hand-counted corpus", () => {
  // Scopes: 0 the corpus; 1 com.acme.order, 2 com.acme.order.billing;
  // 3 billing/Invoice, 4 order/Order, 5 order/Order$Line.
  const glossary = terms("Order", "Order Line", "Invoice", "Invoice Line", "Billing Invoice", "Customer");

  it("at the corpus: a term is spoken when the corpus says every word", () => {
    expect(summary(toy, vocabularyDrift(toy, glossary))).toEqual({
      business: [
        ["Order", [0], []],
        ["Order Line", [0], []],
        ["Invoice", [0], []],
        ["Invoice Line", [0], []],
        ["Billing Invoice", [0], []],
        ["Customer", [], ["customer"]],
      ],
      // `billing` is the business's word too, in "Billing Invoice".
      codeOnly: [
        ["lines", 4, 1, 1],
        ["qty", 4, 1, 1],
        ["total", 4, 2, 1],
        ["acme", 2, 2, 1],
      ],
    });
  });

  it("by module: every word in ONE module, or the term is not spoken there", () => {
    expect(summary(toy, vocabularyDrift(toy, glossary, { level: "module" }))).toEqual({
      business: [
        // The billing package says `order` through its qualifier.
        ["Order", [1, 2], []],
        ["Order Line", [1], []],
        ["Invoice", [2], []],
        // Both words are spoken, never in one module: nothing is missing.
        ["Invoice Line", [], []],
        ["Billing Invoice", [2], []],
        ["Customer", [], ["customer"]],
      ],
      codeOnly: [
        ["lines", 4, 1, 1],
        ["qty", 4, 1, 1],
        ["total", 4, 2, 1],
        ["acme", 2, 2, 2],
      ],
    });
  });

  it("by type: a word only a module's name says is missing from every type", () => {
    expect(summary(toy, vocabularyDrift(toy, glossary, { level: "type" }))).toEqual({
      business: [
        ["Order", [4], []],
        // `line` from the parameter orderLine, inside Order.
        ["Order Line", [4], []],
        ["Invoice", [3], []],
        ["Invoice Line", [], []],
        ["Billing Invoice", [], ["billing"]],
        ["Customer", [], ["customer"]],
      ],
      codeOnly: [
        ["lines", 4, 1, 1],
        ["qty", 4, 1, 1],
        ["total", 4, 2, 1],
      ],
    });
  });

  it("matches a business word to the code's word whatever its class", () => {
    // `get` is technical, `com` too: the business still says them.
    expect(vocabularyDrift(toy, terms("Get Total", "Com")).business.map(({ scopes }) => scopes)).toEqual([[0], [0]]);
  });

  it("lists as code-only the domain words alone, never a technical or keyword one", () => {
    const report = vocabularyDrift(toy, []);
    expect(report.codeOnly.map(({ term }) => toy.terms[term]?.class)).toEqual(
      report.codeOnly.map(() => "domain"),
    );
    expect(report.codeOnly.map(({ term }) => toy.terms[term]?.text)).not.toContain("get");
  });

  it("never stems: `lines` is not the business's `line`", () => {
    expect(summary(toy, vocabularyDrift(toy, terms("Line"))).codeOnly.map(([word]) => word)).toEqual([
      "order",
      "billing",
      "invoice",
      "lines",
      "qty",
      "total",
      "acme",
    ]);
  });

  it("speaks a term with no word nowhere", () => {
    expect(vocabularyDrift(toy, [{ text: "—", words: [] }]).business).toEqual([
      { text: "—", words: [], scopes: [], missing: [] },
    ]);
  });
});

const fixture = (name: string): VocabularyArtifact => {
  const path = fileURLToPath(new URL(`../../../fixtures/${name}/expected/model.jsonl`, import.meta.url));
  return buildVocabulary(buildGraph(loadModels(readModelFileSync(path), { sources: [name] }).union));
};

describe.each(["java", "ruby"])("vocabularyDrift's properties on fixtures/%s", (name) => {
  const artifact = fixture(name);
  const root = new Set(artifact.scopes[0]?.terms.map(([term]) => artifact.terms[term]?.text ?? ""));
  const spoken = [...root].sort();
  const level = fc.constantFrom("corpus" as const, "module" as const, "type" as const);

  it("speaks at the corpus every term made of words the corpus says", () => {
    fc.assert(
      fc.property(fc.array(fc.subarray(spoken, { minLength: 1, maxLength: 3 }), { maxLength: 5 }), (lines) => {
        const report = vocabularyDrift(artifact, terms(...lines.map((words) => words.join(" "))));
        return report.business.every(({ scopes, missing }) => scopes.length === 1 && scopes[0] === 0 && missing.length === 0);
      }),
    );
  });

  it("speaks a term at a level only where the corpus speaks it, in scopes of that level", () => {
    fc.assert(
      fc.property(fc.array(fc.subarray(spoken, { minLength: 1, maxLength: 2 }), { maxLength: 5 }), level, (lines, at) => {
        const report = vocabularyDrift(artifact, terms(...lines.map((words) => words.join(" "))), { level: at });
        return report.business.every(({ scopes }) =>
          scopes.every((scope) => artifact.scopes[scope]?.level === at) &&
          scopes.every((scope, i) => i === 0 || (scopes[i - 1] ?? -1) < scope),
        );
      }),
    );
  });

  it("names as missing exactly the words no scope of the level says", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{3,8}$/), { minLength: 1, maxLength: 3 }), level, (words, at) => {
        const [term] = terms(words.join(" "));
        if (term === undefined) return true;
        const [found] = vocabularyDrift(artifact, [term], { level: at }).business;
        const said = new Set(
          artifact.scopes
            .filter((scope) => scope.level === at)
            .flatMap((scope) => scope.terms.map(([index]) => artifact.terms[index]?.text ?? "")),
        );
        return JSON.stringify(found?.missing) === JSON.stringify(term.words.filter((word) => !said.has(word)));
      }),
    );
  });

  it("keeps every code-only word out of every business term, and sums it over its level", () => {
    fc.assert(
      fc.property(fc.subarray(spoken, { maxLength: 20 }), level, (words, at) => {
        const report = vocabularyDrift(artifact, terms(...words), { level: at });
        const named = new Set(words);
        return report.codeOnly.every(({ term, weight, occurrences, scopes }) => {
          const rows = artifact.scopes
            .filter((scope) => scope.level === at)
            .flatMap((scope) => scope.terms.filter(([index]) => index === term));
          return (
            artifact.terms[term]?.class === "domain" &&
            !named.has(artifact.terms[term]?.text ?? "") &&
            rows.length === scopes &&
            rows.reduce((sum, row) => sum + row[1], 0) === weight &&
            rows.reduce((sum, row) => sum + row[2], 0) === occurrences
          );
        });
      }),
    );
  });
});

