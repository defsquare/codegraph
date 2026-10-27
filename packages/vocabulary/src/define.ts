import { getProfile, type EntityId } from "@codegraph/core";
import { entityName, type CodeGraph } from "@codegraph/analyzer";
import type { VocabularyArtifact } from "./artifact.js";
import { createClassifier, type Classify, type TermClass } from "./classify.js";
import { languagesOf } from "./reading.js";
import { splitIdentifier } from "./split.js";

/**
 * WHAT A MODEL IS ASKED TO DEFINE (PLAN.md §20.3, layer 2). `explain` asks,
 * per unit, for the words of its names; these are the words, so that the
 * prompt asks for exactly what the cloud counts. A qualifier's words are its
 * container's, asked where they are the own name. `short` and `keyword` words
 * are not asked (`i`, `type`); `technical` ones are, since a technical word in
 * a domain position is the point. The class itself is withheld from the
 * caller: the judgement is the model's.
 */

const ASKED: ReadonlySet<TermClass> = new Set(["domain", "technical"]);

/**
 * An entity's own-name words to define, each once, in the order the name
 * spells them; none for an unnamed or conventional name. No technical list:
 * it moves a word between two classes that are both asked.
 */
export function definitionSpeller(graph: CodeGraph): (id: EntityId) => readonly string[] {
  const langOf = languagesOf(graph);
  const classifiers = new Map<string, Classify>();
  return (id) => {
    const entity = graph.entity(id);
    const name = entity === undefined ? undefined : entityName(entity);
    if (entity === undefined || name === undefined) return [];
    const lang = langOf.get(id) ?? "";
    const lexicon = getProfile(lang)?.lexicon;
    let classify = classifiers.get(lang);
    if (classify === undefined) {
      classify = createClassifier(lexicon);
      classifiers.set(lang, classify);
    }
    const split = splitIdentifier(name, entity.kind, lexicon);
    const asked = split.tokens.slice(split.qualifier).filter((token) => ASKED.has(classify(token)));
    return [...new Set(asked)];
  };
}

/** A scope's words a definition can be asked for, heaviest first as its table orders them; `undefined` is the corpus. */
export function rankedWords(artifact: VocabularyArtifact, scopeId: EntityId | undefined): readonly string[] {
  const scope = artifact.scopes.find((candidate) => candidate.id === scopeId);
  const words = new Set<string>();
  for (const [index] of scope?.terms ?? []) {
    const term = artifact.terms[index];
    if (term !== undefined && ASKED.has(term.class)) words.add(term.text);
  }
  return [...words];
}
