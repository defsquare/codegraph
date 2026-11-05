import type { Carrier, TermClass, VocabularyArtifact } from "@codegraph/vocabulary";
import type { CloudWord } from "@codegraph/vocabulary/cloud";
import type { ModelIndexes } from "./indexes.js";

/**
 * The Vocabulary tab's model: the artifact's rows read for one scope, and the
 * joins to the navigator — both on the entity id, compared as an opaque token,
 * as the city's buildings are. Nothing is counted here; every number is the
 * artifact's.
 */

export interface VocabularyIndex {
  readonly artifact: VocabularyArtifact;
  /** A module's or a type's id → its scope's index. */
  readonly scopeById: ReadonlyMap<string, number>;
}

export function indexVocabulary(artifact: VocabularyArtifact): VocabularyIndex {
  const scopeById = new Map<string, number>();
  artifact.scopes.forEach((scope, index) => {
    if (scope.id !== undefined) scopeById.set(scope.id, index);
  });
  return { artifact, scopeById };
}

/**
 * The scope the tab shows for the Navigate selection: the node's own when the
 * vocabulary has it (a module, a type), else the nearest ancestor's — a member
 * shows its type — and the corpus when nothing is selected or nothing matches.
 */
export function scopeForNode(ix: ModelIndexes, vocabulary: VocabularyIndex, node: number | undefined): number {
  const seen = new Set<number>();
  for (let cursor = node; cursor !== undefined && !seen.has(cursor); cursor = ix.model.nodes[cursor]?.parent) {
    seen.add(cursor);
    const id = ix.model.nodes[cursor]?.id;
    const scope = id === undefined ? undefined : vocabulary.scopeById.get(id);
    if (scope !== undefined) return scope;
  }
  return 0;
}

/** The scope and the stored scopes around it, the corpus first. */
export function scopeChain(artifact: VocabularyArtifact, scope: number): readonly number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  for (let cursor: number | undefined = scope; cursor !== undefined && !seen.has(cursor); cursor = artifact.scopes[cursor]?.parent) {
    seen.add(cursor);
    chain.unshift(cursor);
  }
  if (chain[0] !== 0) chain.unshift(0);
  return chain;
}

export interface WordRow {
  /** The term's index in the artifact. */
  readonly term: number;
  readonly text: string;
  readonly class: TermClass;
  readonly weight: number;
  readonly occurrences: number;
  readonly carriers: number;
  /** How many module scopes, and type scopes, of the corpus speak it. */
  readonly modules: number;
  readonly types: number;
}

/** A scope's rows of the chosen classes, in the artifact's order: weight descending, then term. */
export function wordRows(artifact: VocabularyArtifact, scope: number, classes: ReadonlySet<TermClass>): readonly WordRow[] {
  const rows: WordRow[] = [];
  for (const [term, weight, occurrences, carriers] of artifact.scopes[scope]?.terms ?? []) {
    const entry = artifact.terms[term];
    if (entry === undefined || !classes.has(entry.class)) continue;
    rows.push({ term, text: entry.text, class: entry.class, weight, occurrences, carriers, modules: entry.modules, types: entry.types });
  }
  return rows;
}

/** The N heaviest as the layout's input: the same words the CLI's `--svg --top N` draws. */
export function cloudWords(rows: readonly WordRow[], top: number): readonly CloudWord[] {
  return rows.slice(0, top).map((row) => ({ text: row.text, weight: row.weight, class: row.class }));
}

/** The navigator node a carrier reveals: its own when it is a type or a module, else its owner's. */
export function carrierNode(ix: ModelIndexes, carrier: Carrier): number | undefined {
  const id = carrier.id ?? carrier.owner;
  return id === undefined ? undefined : ix.nodeById.get(id);
}
