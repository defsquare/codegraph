import type { ScopeLevel, VocabularyArtifact } from "./artifact.js";
import { splitIdentifier } from "./split.js";

/**
 * DRIFT (PLAN.md §20.1): a business glossary against the words the code
 * speaks. A business term is spoken in a scope when every one of its words is,
 * whatever class the code gives the word; the other half is the `domain`
 * words the code speaks that no business term contains. Words match as
 * written: `lines` is not `line`, nothing is stemmed.
 */

/** One glossary line: the text as written and the words the universal rules make of it. */
export interface BusinessTerm {
  readonly text: string;
  readonly words: readonly string[];
}

export interface BusinessTerms {
  /** In the file's order; a term whose words repeat an earlier one's is that term. */
  readonly terms: readonly BusinessTerm[];
  /** Lines that name no word (`2024`, `—`): no term, said so. */
  readonly wordless: readonly { readonly line: number; readonly text: string }[];
}

/**
 * One business term per line, split with no lexicon, so `Order Line` meets
 * `order` and `line`. Lines are trimmed; blank lines and `#` comments are not
 * terms.
 */
export function parseBusinessTerms(text: string): BusinessTerms {
  const terms: BusinessTerm[] = [];
  const wordless: { line: number; text: string }[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const words = [...new Set(splitIdentifier(line, "", undefined).tokens)];
    if (words.length === 0) {
      wordless.push({ line: i + 1, text: line });
      return;
    }
    const key = words.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ text: line, words });
  });
  return { terms, wordless };
}

export interface SpokenTerm extends BusinessTerm {
  /** The scopes of the level that say every word, by index into the artifact's `scopes`. */
  readonly scopes: readonly number[];
  /** Its words no scope of the level says at all; empty with no scope when they are never said together. */
  readonly missing: readonly string[];
}

export interface CodeOnlyWord {
  /** Index into the artifact's `terms`; always a `domain` term. */
  readonly term: number;
  /** Summed over the scopes of the level that speak it. */
  readonly weight: number;
  readonly occurrences: number;
  readonly scopes: number;
}

export interface DriftReport {
  readonly level: ScopeLevel;
  /** Every business term, in the glossary's order. */
  readonly business: readonly SpokenTerm[];
  /** By weight descending, then term. */
  readonly codeOnly: readonly CodeOnlyWord[];
}

export function vocabularyDrift(
  artifact: VocabularyArtifact,
  terms: readonly BusinessTerm[],
  options: { readonly level?: ScopeLevel } = {},
): DriftReport {
  const level = options.level ?? "corpus";

  // Which scopes of the level say each word (any class), in scope order.
  const speakers = new Map<string, number[]>();
  const codeOnly = new Map<number, { weight: number; occurrences: number; scopes: number }>();
  artifact.scopes.forEach((scope, index) => {
    if (scope.level !== level) return;
    for (const [term, weight, occurrences] of scope.terms) {
      const entry = artifact.terms[term];
      if (entry === undefined) continue;
      const list = speakers.get(entry.text) ?? [];
      if (list[list.length - 1] !== index) list.push(index);
      speakers.set(entry.text, list);
      if (entry.class !== "domain") continue;
      const sum = codeOnly.get(term) ?? { weight: 0, occurrences: 0, scopes: 0 };
      sum.weight += weight;
      sum.occurrences += occurrences;
      sum.scopes += 1;
      codeOnly.set(term, sum);
    }
  });

  const business = terms.map((term): SpokenTerm => {
    const lists = term.words.map((word) => speakers.get(word) ?? []);
    const missing = term.words.filter((_word, i) => lists[i]?.length === 0);
    const [first = [], ...others] = lists;
    const sets = others.map((list) => new Set(list));
    const scopes = first.filter((scope) => sets.every((set) => set.has(scope)));
    return { text: term.text, words: term.words, scopes, missing };
  });

  const named = new Set(terms.flatMap((term) => term.words));
  return {
    level,
    business,
    codeOnly: [...codeOnly]
      .filter(([term]) => !named.has(artifact.terms[term]?.text ?? ""))
      .map(([term, sum]): CodeOnlyWord => ({ term, ...sum }))
      .sort((a, b) => b.weight - a.weight || a.term - b.term),
  };
}
