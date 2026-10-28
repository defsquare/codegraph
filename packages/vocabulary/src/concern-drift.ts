import { getProfile, type EntityId } from "@codegraph/core";
import { compareIds, identityView, type CodeGraph, type View } from "@codegraph/analyzer";
import type { VocabularyArtifact } from "./artifact.js";
import { DEFAULT_TECHNICAL, TERM_CLASSES, createClassifier, type Classify, type TermClass } from "./classify.js";
import type { BusinessTerm } from "./drift.js";
import { languagesOf, technicalDigest } from "./reading.js";

/**
 * THE LIST AGAINST THE MODEL (PLAN.md §20.3, layer 3): the class the
 * deterministic rules give a word, beside the concern a model judged it to
 * have in each explained entity whose names spell it. A technical word judged
 * domain is a technical word in a domain position (`service` in
 * `CustomerServiceTicket`); a domain word judged technical is a candidate for
 * the list. Neither is a fact: both sides are reported, nothing is decided.
 *
 * The judgements come from the insights store, which this package never
 * imports: the caller hands them over in this file's shape.
 */

/** What a model may call a word: the insights block's concerns, restated (a CLI test pins the two equal). */
export const JUDGED_CONCERNS = ["domain", "technical", "ambiguous"] as const;
export type JudgedConcern = (typeof JUDGED_CONCERNS)[number];

/** One entry of an explained entity's `words`: the model's judgement of one word in that entity. */
export interface WordJudgement {
  readonly id: EntityId;
  readonly word: string;
  readonly concern: JudgedConcern;
  readonly sense: string;
  readonly confidence: number;
  /** The entity's identifiers the word is in. */
  readonly in: readonly string[];
}

export type ConcernCounts = Readonly<Record<JudgedConcern, number>>;

/** A word under one class: a class is decided per language, so a word judged in two may be two rows. */
export interface JudgedWord {
  readonly word: string;
  readonly class: TermClass;
  readonly concerns: ConcernCounts;
  /** The judgements the class contradicts — domain for a technical word, technical for a domain one; most confident first. */
  readonly against: readonly WordJudgement[];
}

export interface ConcernDrift {
  /** By word in code-unit order, then class. */
  readonly words: readonly JudgedWord[];
  /** The list says technical, a model said domain: the most judgements against first, ties by word. */
  readonly technicalJudgedDomain: readonly JudgedWord[];
  /** The list says domain, a model said technical; ranked likewise. */
  readonly domainJudgedTechnical: readonly JudgedWord[];
  readonly compared: { readonly entries: number; readonly entities: number };
  /** Records left out, by distinct id: no entity of this model (explained against another version), or none the view keeps. */
  readonly leftOut: { readonly unknown: number; readonly notKept: number };
  /** The list the classes came from, as an artifact states it. */
  readonly technical: VocabularyArtifact["technical"];
}

export interface ConcernDriftOptions {
  readonly view?: View;
  /** Replaces the shared technical list whole, as `buildVocabulary`'s option does. */
  readonly technical?: readonly string[];
}

/**
 * Compare every judgement of a kept entity with the class the list gives its
 * word in that entity's language — read from the union, never from its id.
 * Kept is the vocabulary's rule: the view's verdict on a non-stub entity.
 */
export function concernDrift(
  graph: CodeGraph,
  judgements: Iterable<WordJudgement>,
  options: ConcernDriftOptions = {},
): ConcernDrift {
  const view = options.view ?? identityView;
  const technical = options.technical ?? DEFAULT_TECHNICAL;
  const langOf = languagesOf(graph);
  const classifiers = new Map<string, Classify>();
  const classOf = (id: EntityId, word: string): TermClass => {
    const lang = langOf.get(id) ?? "";
    let classify = classifiers.get(lang);
    if (classify === undefined) {
      classify = createClassifier(getProfile(lang)?.lexicon, technical);
      classifiers.set(lang, classify);
    }
    return classify(word);
  };

  const rows = new Map<string, { word: string; class: TermClass; concerns: Record<JudgedConcern, number>; against: WordJudgement[] }>();
  const unknown = new Set<EntityId>();
  const notKept = new Set<EntityId>();
  const entities = new Set<EntityId>();
  let entries = 0;
  for (const judgement of judgements) {
    const entity = graph.entity(judgement.id);
    if (entity === undefined) {
      unknown.add(judgement.id);
      continue;
    }
    if (graph.isStub(judgement.id) || !view.entity(entity, graph)) {
      notKept.add(judgement.id);
      continue;
    }
    const termClass = classOf(judgement.id, judgement.word);
    const key = `${termClass}\u0000${judgement.word}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = { word: judgement.word, class: termClass, concerns: { domain: 0, technical: 0, ambiguous: 0 }, against: [] };
      rows.set(key, row);
    }
    row.concerns[judgement.concern] += 1;
    if (judgement.concern === OPPOSITE[termClass]) row.against.push(judgement);
    entities.add(judgement.id);
    entries += 1;
  }

  const words: JudgedWord[] = [...rows.values()]
    .map((row) => ({ ...row, against: row.against.sort(byJudgement) }))
    .sort((a, b) => compareIds(a.word, b.word) || TERM_CLASSES.indexOf(a.class) - TERM_CLASSES.indexOf(b.class));
  const contradicted = (termClass: TermClass): JudgedWord[] =>
    words
      .filter((w) => w.class === termClass && w.against.length > 0)
      .sort((a, b) => b.against.length - a.against.length || compareIds(a.word, b.word));
  return {
    words,
    technicalJudgedDomain: contradicted("technical"),
    domainJudgedTechnical: contradicted("domain"),
    compared: { entries, entities: entities.size },
    leftOut: { unknown: unknown.size, notKept: notKept.size },
    technical: technicalDigest(technical),
  };
}

/** The concern a class is contradicted by; the classes a definition is never asked for have none. */
const OPPOSITE: Readonly<Record<TermClass, JudgedConcern | undefined>> = {
  domain: "technical",
  technical: "domain",
  keyword: undefined,
  short: undefined,
};

/** The model's surest first, the telling ones; then by entity and what was said, whatever order the store answered in. */
function byJudgement(a: WordJudgement, b: WordJudgement): number {
  return (
    b.confidence - a.confidence ||
    compareIds(a.id, b.id) ||
    compareIds(a.sense, b.sense) ||
    compareIds(a.in.join("\u0000"), b.in.join("\u0000"))
  );
}

/** Why a business word drifts: the list does not call it domain, or a model judged it technical somewhere. */
export type BusinessDrift = "list" | "model";

export interface BusinessWordJudged {
  readonly word: string;
  /** The classes the corpus says it under; none when no kept name says it. */
  readonly classes: readonly TermClass[];
  /** Over every entity that judged it, whatever its class there. */
  readonly concerns: ConcernCounts;
  /** Empty when both call it domain, or say nothing of it. */
  readonly drift: readonly BusinessDrift[];
}

export interface BusinessTermJudged {
  readonly text: string;
  readonly words: readonly BusinessWordJudged[];
  /** Every word of it said by the corpus: `vocabularyDrift`'s answer at the corpus level. */
  readonly said: boolean;
  /** A word of it drifts. */
  readonly drift: boolean;
}

/**
 * The business list against both (PLAN.md §20.3): a business term is a domain
 * concept by definition, so each of its words is shown with what the list and
 * the model call it. The artifact must be counted under the drift's own list.
 */
export function businessJudged(
  artifact: VocabularyArtifact,
  terms: readonly BusinessTerm[],
  drift: ConcernDrift,
): readonly BusinessTermJudged[] {
  if (artifact.technical.sha256 !== drift.technical.sha256) {
    throw new Error("businessJudged: the artifact was counted under another technical list than the drift");
  }
  const classes = new Map<string, TermClass[]>();
  for (const term of artifact.terms) classes.set(term.text, [...(classes.get(term.text) ?? []), term.class]);
  const concerns = new Map<string, Record<JudgedConcern, number>>();
  for (const w of drift.words) {
    const sum = concerns.get(w.word) ?? { domain: 0, technical: 0, ambiguous: 0 };
    for (const concern of JUDGED_CONCERNS) sum[concern] += w.concerns[concern];
    concerns.set(w.word, sum);
  }
  return terms.map((term): BusinessTermJudged => {
    const words = term.words.map((word): BusinessWordJudged => {
      const said = classes.get(word) ?? [];
      const judged = concerns.get(word) ?? { domain: 0, technical: 0, ambiguous: 0 };
      const drift: BusinessDrift[] = [
        ...(said.some((c) => c !== "domain") ? (["list"] as const) : []),
        ...(judged.technical > 0 ? (["model"] as const) : []),
      ];
      return { word, classes: said, concerns: judged, drift };
    });
    return {
      text: term.text,
      words,
      said: words.every((w) => w.classes.length > 0),
      drift: words.some((w) => w.drift.length > 0),
    };
  });
}
