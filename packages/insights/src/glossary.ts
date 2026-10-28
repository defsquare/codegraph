import { naturalKeyIndex, naturalKeyIssues, renderId, type NaturalKey } from "@codegraph/core";
import { WORD_CONCERNS, type InsightRecord, type Level, type RecordKey, type WordConcern } from "./schema.js";
import type { GlossaryHit, InsightsStore, WordHit } from "./store.js";

/**
 * THE READERS OF THE WORDS (PLAN.md §20.3, layer 3): what the records' `words`
 * and the modules' `glossary` say, rolled up over the store. None calls a
 * model; none opens the model either — a record is placed in its module by its
 * natural key, rendered by core, never by parsing its id.
 *
 * A record a model wrote under prompt 1 defines no word, so every report also
 * says how many such records it cannot see (`withoutWords`).
 */

/** Why a record carries no `words`: a model explained it under prompt 1, before words were asked; or no model did (a template). */
export type WordsAbsence = "prompt-1" | "templated";

export function wordsAbsence(record: InsightRecord): WordsAbsence | undefined {
  if (record.block.words !== undefined) return undefined;
  return record.origin === "template" ? "templated" : "prompt-1";
}

/** The rendered id of the module a key names; undefined without a key, or for one core cannot render (a hand-edited side-car's). */
export function moduleOf(key: RecordKey | undefined): string | undefined {
  const module = moduleKey(key);
  return module === undefined ? undefined : renderId(module);
}

function moduleKey(key: RecordKey | undefined): NaturalKey | undefined {
  if (key === undefined) return undefined;
  // MM-1: a module names itself, its symbol empty.
  const module: NaturalKey = { lang: key.lang, module: key.module, symbol: "" };
  return naturalKeyIssues(module).length === 0 ? module : undefined;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Module ids in code-unit order, the records without one last. */
const byModule = (a: string | undefined, b: string | undefined): number =>
  a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : byCodeUnits(a, b);

interface ModuleGroup<T> {
  /** `naturalKeyIndex`, the comparable form: the rendered id is for display (MM-1). */
  readonly index: string | undefined;
  readonly module: string | undefined;
  readonly items: T[];
}

function groupByModule<T>(items: readonly T[], keyOf: (item: T) => RecordKey | undefined): Map<string | undefined, ModuleGroup<T>> {
  const groups = new Map<string | undefined, ModuleGroup<T>>();
  for (const item of items) {
    const key = moduleKey(keyOf(item));
    const index = key === undefined ? undefined : naturalKeyIndex(key);
    let group = groups.get(index);
    if (group === undefined) {
      group = { index, module: key === undefined ? undefined : renderId(key), items: [] };
      groups.set(index, group);
    }
    group.items.push(item);
  }
  return groups;
}

export interface WordModule {
  /** The module's rendered id; undefined gathers the records whose natural key is missing or cannot render. */
  readonly module: string | undefined;
  /** The module's own reconciliation of the word, when its glossary has one. */
  readonly glossary: readonly GlossaryHit[];
  /** The module itself, then its types, then its operations; by id within a level. */
  readonly entries: readonly WordHit[];
}

export interface WordReport {
  /** As the splitter spells it: lowercase. */
  readonly word: string;
  readonly modules: readonly WordModule[];
  readonly withoutWords: number;
}

const TOP_DOWN: Readonly<Record<Level, number>> = { module: 0, type: 1, operation: 2 };

/** `insights --word`: every entity whose names spell the word, by module, from one index lookup. */
export function wordReport(store: InsightsStore, word: string): WordReport {
  // `toLowerCase`, as the splitter: locale-independent.
  const spelled = word.toLowerCase();
  const entries = groupByModule(store.wordHits(spelled), (hit) => hit.key);
  const glossaries = groupByModule(store.glossaryEntries(spelled), (hit) => hit.key);
  const modules: WordModule[] = [];
  for (const group of entries.values()) {
    const sorted = [...group.items].sort((a, b) => TOP_DOWN[a.level] - TOP_DOWN[b.level] || byCodeUnits(a.id, b.id));
    modules.push({ module: group.module, glossary: glossaries.get(group.index)?.items ?? [], entries: sorted });
  }
  // A glossary entry with no entity behind it here (its types answered without the word) is still the module's.
  for (const group of glossaries.values()) if (!entries.has(group.index)) modules.push({ module: group.module, glossary: group.items, entries: [] });
  return { word: spelled, modules: modules.sort((a, b) => byModule(a.module, b.module)), withoutWords: store.withoutWords() };
}

export interface PolysemousWord {
  readonly word: string;
  /** A module's glossary flags it: that module's types disagree on it. */
  readonly flagged: boolean;
  /** The modules' entries give it more than one sense. */
  readonly acrossModules: boolean;
  /** Distinct senses over the entries and the senses a flag lists. */
  readonly senses: number;
  /** Every module's entry for the word, by module id: side by side, for a human to judge. */
  readonly entries: readonly GlossaryHit[];
}

export interface PolysemyReport {
  /** The most senses first, then by word. */
  readonly words: readonly PolysemousWord[];
  readonly withoutWords: number;
}

/** Two senses are one when they differ only in case and spacing: the model's wording varies, its meaning is what is compared. */
const sense = (text: string): string => text.trim().replace(/\s+/gu, " ").toLowerCase();

/** `insights --polysemy`: the corpus has no call to judge a word across modules, so this lays the modules' senses side by side. */
export function polysemyReport(store: InsightsStore): PolysemyReport {
  const byWord = new Map<string, GlossaryHit[]>();
  for (const hit of store.glossaryEntries()) {
    const hits = byWord.get(hit.entry.word) ?? [];
    hits.push(hit);
    byWord.set(hit.entry.word, hits);
  }
  const words: PolysemousWord[] = [];
  for (const [word, entries] of byWord) {
    const flagged = entries.some((hit) => hit.entry.polysemous);
    const judged = new Set(entries.map((hit) => `${hit.entry.concern}\u0000${sense(hit.entry.sense)}`));
    const senses = new Set(entries.flatMap((hit) => [hit.entry.sense, ...hit.entry.senses.map((s) => s.sense)].map(sense)));
    if (flagged || judged.size > 1) words.push({ word, flagged, acrossModules: judged.size > 1, senses: senses.size, entries });
  }
  words.sort((a, b) => b.senses - a.senses || byCodeUnits(a.word, b.word));
  return { words, withoutWords: store.withoutWords() };
}

export interface ModuleConcerns {
  readonly module: string | undefined;
  /** Distinct words its records define. */
  readonly words: number;
  /** Distinct words given each concern: a word two units judged differently counts under both. */
  readonly concerns: Readonly<Record<WordConcern, number>>;
}

export interface ConcernsReport {
  /** The most words first, then by module id; the records without a natural key last. */
  readonly modules: readonly ModuleConcerns[];
  readonly withoutWords: number;
}

/** `insights --concerns`: per module, the cognitive-load proxy of PLAN.md §20.3 split by what the model judged each word to be about. */
export function concernsReport(store: InsightsStore): ConcernsReport {
  const groups = groupByModule(store.concernRows(), (row) =>
    row.lang === undefined || row.module === undefined ? undefined : { lang: row.lang, module: row.module, symbol: "" },
  );
  const modules = [...groups.values()].map((group): ModuleConcerns => {
    const concerns = Object.fromEntries(WORD_CONCERNS.map((concern) => [concern, 0])) as Record<WordConcern, number>;
    for (const row of group.items) concerns[row.concern] += 1;
    return { module: group.module, words: new Set(group.items.map((row) => row.word)).size, concerns };
  });
  const unplaced = (m: ModuleConcerns): number => (m.module === undefined ? 1 : 0);
  modules.sort((a, b) => unplaced(a) - unplaced(b) || b.words - a.words || byModule(a.module, b.module));
  return { modules, withoutWords: store.withoutWords() };
}
