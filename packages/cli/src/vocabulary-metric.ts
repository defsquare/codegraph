import type { MetricSource } from "@codegraph/city";
import { splitIdentifier, type VocabularyArtifact } from "@codegraph/vocabulary";
import { UsageError } from "./exit.js";

/**
 * THE CITY'S VOCABULARY CHANNEL (PLAN.md §20.2): `vocabulary:<word>` measures
 * a building by the word's weight in its type's names — the type and every
 * member folded into it, the Vocabulary tab's type scope — so the tab and the
 * city read one number, and `--height vocabulary:order` shows where `order`
 * lives.
 *
 * A type whose names never say the word weighs 0, a measured zero; a building
 * with no type scope (a stub: its name is another corpus's word) is
 * unmeasured. The metric is about the text, so the classes two languages give
 * it add up. The artifact is counted only when such a metric is named.
 */

export const VOCABULARY_PREFIX = "vocabulary:";

export function vocabularyMetric(name: string, vocabulary: () => VocabularyArtifact): MetricSource | undefined {
  if (!name.startsWith(VOCABULARY_PREFIX)) return undefined;
  const typed = name.slice(VOCABULARY_PREFIX.length);
  // The splitter's own rule, so `Order` is `order` and `OrderLine` is two words.
  const { tokens } = splitIdentifier(typed, "", undefined);
  const [word] = tokens;
  if (word === undefined || tokens.length > 1) {
    throw new UsageError(
      tokens.length > 1
        ? `${name} names ${tokens.length} words (${tokens.join(", ")}); a metric measures one`
        : `${name} names no word`,
      "Write one word after vocabulary:, e.g. vocabulary:order.",
    );
  }

  const artifact = vocabulary();
  const said = new Set<number>();
  artifact.terms.forEach((term, index) => {
    if (term.text === word) said.add(index);
  });
  if (said.size === 0) {
    throw new UsageError(
      `${name}: no name in view ${artifact.view.name} says "${word}"`,
      "Run 'codegraph vocabulary <model.jsonl>' for the words it does say.",
    );
  }
  const byType = new Map<string, number>();
  for (const scope of artifact.scopes) {
    if (scope.level !== "type" || scope.id === undefined) continue;
    let weight = 0;
    for (const [term, termWeight] of scope.terms) if (said.has(term)) weight += termWeight;
    byType.set(scope.id, weight);
  }
  return {
    name,
    unit: "weighted occurrences",
    describe:
      `Weight of "${word}" in the names of the type and its members, each occurrence weighted by ` +
      `its name's role, as codegraph vocabulary counts it. A stub's names are not counted.`,
    value: ({ node }) => byType.get(node.id),
  };
}
