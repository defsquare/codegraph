import { createHash } from "node:crypto";
import { getProfile, type Entity, type EntityId } from "@codegraph/core";
import { compareIds, entityName, type CodeGraph, type View } from "@codegraph/analyzer";
import { TERM_CLASSES, createClassifier, type Classify, type TermClass } from "./classify.js";
import { splitIdentifier } from "./split.js";
import { roleOf, structuralSlots, type Role, type Weights } from "./weight.js";

/**
 * THE ONE COUNTING RULE, read once per entity: what its name says, under one
 * set of weights and one technical list. The artifact folds a reading into
 * every scope the entity belongs to; the carriers keep it per entity. Both
 * read through here, so a carrier's share is exactly what the row counted.
 *
 * Internal: `index.ts` does not export it.
 */

/** What one kept entity's name contributes: nothing, and why, or its words. */
export type Reading =
  | { readonly said: "nothing"; readonly why: "unnamed" | "conventional" }
  | {
      readonly said: "words";
      readonly role: Role;
      /** Digit-only pieces dropped from the name. */
      readonly numeric: number;
      /** Interned term → `[weight, occurrences]`; a word said twice is one entry. */
      readonly words: ReadonlyMap<number, readonly [weight: number, occurrences: number]>;
    };

/** Kept is the view's verdict on a non-stub entity: a stub's name is a word another corpus chose. */
export function keptEntities(graph: CodeGraph, view: View): Entity[] {
  const kept: Entity[] = [];
  for (const id of graph.ids()) {
    const entity = graph.entity(id);
    if (entity !== undefined && !graph.isStub(id) && view.entity(entity, graph)) kept.push(entity);
  }
  return kept;
}

/**
 * Reads one entity's words: its role's weight per word, `qualifier` before the
 * last separator of a qualified name. An entity's language is its model's —
 * read from the union, never from its id.
 */
export function readerFor(
  graph: CodeGraph,
  terms: Interner,
  weights: Weights,
  technical: readonly string[],
): (entity: Entity) => Reading {
  const slots = structuralSlots(graph.entities.values());
  const langOf = languagesOf(graph);
  const classifiers = new Map<string, Classify>();
  const classifierOf = (lang: string): Classify => {
    let classify = classifiers.get(lang);
    if (classify === undefined) {
      classify = createClassifier(getProfile(lang)?.lexicon, technical);
      classifiers.set(lang, classify);
    }
    return classify;
  };

  return (entity) => {
    const name = entityName(entity);
    if (name === undefined) return { said: "nothing", why: "unnamed" };
    const lang = langOf.get(entity.id) ?? "";
    const split = splitIdentifier(name, entity.kind, getProfile(lang)?.lexicon);
    if (split.conventional) return { said: "nothing", why: "conventional" };
    const role = roleOf(entity, slots);
    const classify = classifierOf(lang);
    const words = new Map<number, [number, number]>();
    split.tokens.forEach((token, i) => {
      const term = terms.intern(token, classify(token));
      const row = words.get(term) ?? [0, 0];
      row[0] += i < split.qualifier ? weights.qualifier : weights[role];
      row[1] += 1;
      words.set(term, row);
    });
    return { said: "words", role, numeric: split.numeric, words };
  };
}

/** The technical list as the artifact states it: its distinct words, sorted, and a sha256 over them, one per line. */
export function technicalDigest(technical: readonly string[]): { readonly words: number; readonly sha256: string } {
  const words = [...new Set(technical)].sort(compareIds);
  return { words: words.length, sha256: createHash("sha256").update(words.join("\n"), "utf8").digest("hex") };
}

/** Each id's language, from the model that declares it first — the graph's own rule. */
export function languagesOf(graph: CodeGraph): Map<EntityId, string> {
  const langs = new Map<EntityId, string>();
  for (const model of graph.union.models) {
    for (const entity of model.entities) if (!langs.has(entity.id)) langs.set(entity.id, model.lang);
  }
  return langs;
}

/** Words interned once per (text, class): a class is decided per language. */
export class Interner {
  private readonly ids = new Map<string, Map<TermClass, number>>();
  private readonly entries: { readonly id: number; readonly text: string; readonly class: TermClass }[] = [];

  /** Seeded with an artifact's terms, an interned word IS its index there. */
  constructor(seed: readonly { readonly text: string; readonly class: TermClass }[] = []) {
    for (const { text, class: termClass } of seed) this.intern(text, termClass);
  }

  size(): number {
    return this.entries.length;
  }

  intern(text: string, termClass: TermClass): number {
    let byClass = this.ids.get(text);
    if (byClass === undefined) {
      byClass = new Map();
      this.ids.set(text, byClass);
    }
    const existing = byClass.get(termClass);
    if (existing !== undefined) return existing;
    const id = this.entries.length;
    byClass.set(termClass, id);
    this.entries.push({ id, text, class: termClass });
    return id;
  }

  /** By text in code-unit order, then by the classes' order: the same bytes on every machine. */
  sorted(): readonly { readonly id: number; readonly text: string; readonly class: TermClass }[] {
    return [...this.entries].sort(
      (a, b) => compareIds(a.text, b.text) || TERM_CLASSES.indexOf(a.class) - TERM_CLASSES.indexOf(b.class),
    );
  }
}
