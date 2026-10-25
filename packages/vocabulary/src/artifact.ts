import type { ViewDescriptor } from "@codegraph/analyzer";
import type { TermClass } from "./classify.js";
import type { Role, Weights } from "./weight.js";

/**
 * THE VOCABULARY ARTIFACT (PLAN.md §20.1): the words of a corpus's names,
 * counted per scope — the corpus, each module, each type — as the fold places
 * every entity. A third model beside the city's and the navigator's, derived
 * from the first and never written back into it.
 *
 * Indexes, not ids, address its rows: a term is its position in `terms`, a
 * scope's parent its position in `scopes`. Scopes carry the entity's rendered
 * id, opaque, so another artifact's building or tree node finds its words.
 */

export const VOCABULARY_ARTEFACT_KIND = "codegraph.vocabulary/1";
export const VOCABULARY_GENERATOR = "@codegraph/vocabulary";

export const SCOPE_LEVELS = ["corpus", "module", "type"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** `[term, weight, occurrences, carriers]`: `term` indexes `terms`; carriers are distinct entities. */
export type TermRow = readonly [term: number, weight: number, occurrences: number, carriers: number];

export interface VocabularyTerm {
  readonly text: string;
  /** Decided per language: one word two languages class apart is two terms. */
  readonly class: TermClass;
  /** How many module scopes, and how many type scopes, speak it. */
  readonly modules: number;
  readonly types: number;
  /** The one module scope that speaks it, when exactly one does. */
  readonly exclusive?: number;
}

/** What a scope's entities did not contribute. */
export interface Skipped {
  /** Entities with no name: a constructor, a lambda. */
  readonly unnamed: number;
  /** Names the language dictates (`toString`): no word at all. */
  readonly conventional: number;
  /** Pieces of digits only (`2024` of `promo#2024`), dropped. */
  readonly numeric: number;
}

export interface VocabularyScope {
  readonly level: ScopeLevel;
  /** The entity's rendered id; absent on the corpus. Compared, never parsed. */
  readonly id?: string;
  readonly name: string;
  /** The entity kind, verbatim; absent on the corpus. */
  readonly kind?: string;
  /** The nearest scope the model declares around it; absent on the corpus. */
  readonly parent?: number;
  /** Kept entities the fold puts here: each one unnamed, conventional, or counted in `roles`. */
  readonly entities: number;
  /** The entities that spoke words, by the role of each. */
  readonly roles: Readonly<Record<Role, number>>;
  readonly skipped: Skipped;
  /** Terms in the table, and the `domain` ones among them: the cognitive-load proxy. */
  readonly distinct: number;
  readonly distinctDomain: number;
  /** Sums over the table. */
  readonly weight: number;
  readonly occurrences: number;
  /** By weight descending, then term. */
  readonly terms: readonly TermRow[];
}

export interface VocabularyDiagnostics {
  /** Kept entities no module contains, sorted: counted at the corpus alone. */
  readonly unplaced: readonly string[];
  /** Languages core has no lexicon for, sorted: split by the universal rules alone. */
  readonly withoutLexicon: readonly string[];
}

export interface VocabularyArtifact {
  /** Always `codegraph.vocabulary/1` — derived, never an interchange model.jsonl. */
  readonly kind: string;
  readonly generatedBy: string;
  /** A count without its view is not a fact; nor without its weights or its technical list. */
  readonly view: ViewDescriptor;
  readonly corpus: { readonly name: string; readonly roots: readonly string[] };
  readonly langs: readonly string[];
  readonly weights: Weights;
  readonly classes: readonly TermClass[];
  /** The shared technical list: its size, and a sha256 over its sorted words, one per line. */
  readonly technical: { readonly words: number; readonly sha256: string };
  /** Sorted by text, then class. */
  readonly terms: readonly VocabularyTerm[];
  /** The corpus first, then modules, then types, each level in id order. */
  readonly scopes: readonly VocabularyScope[];
  readonly diagnostics: VocabularyDiagnostics;
}

/**
 * The artifact as JSON, deterministically: every array the builder writes is
 * sorted, so insertion order is the byte order. Compact by default (thousands
 * of scopes on a real corpus); `pretty` puts one term and one scope per line,
 * the form of the committed snapshots, so a diff reads word by word.
 */
export function vocabularyToJsonString(
  artifact: VocabularyArtifact,
  options?: { readonly pretty?: boolean },
): string {
  if (options?.pretty !== true) return JSON.stringify(artifact);
  const entries = Object.entries(artifact).map(([key, value]) => {
    const text = Array.isArray(value) && (key === "terms" || key === "scopes") ? rows(value) : JSON.stringify(value);
    return `  ${JSON.stringify(key)}: ${text}`;
  });
  return `{\n${entries.join(",\n")}\n}\n`;
}

function rows(values: readonly unknown[]): string {
  return values.length === 0 ? "[]" : `[\n${values.map((value) => `    ${JSON.stringify(value)}`).join(",\n")}\n  ]`;
}
