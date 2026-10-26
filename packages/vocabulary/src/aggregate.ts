import { createHash } from "node:crypto";
import { getProfile, type Entity, type EntityId } from "@codegraph/core";
import {
  compareIds,
  entityName,
  folderFor,
  hasTrait,
  identityView,
  type CodeGraph,
  type View,
} from "@codegraph/analyzer";
import {
  VOCABULARY_ARTEFACT_KIND,
  VOCABULARY_GENERATOR,
  type OperationScope,
  type ScopeLevel,
  type TermRow,
  type VocabularyArtifact,
  type VocabularyScope,
  type VocabularyTerm,
} from "./artifact.js";
import { DEFAULT_TECHNICAL, TERM_CLASSES, createClassifier, type Classify, type TermClass } from "./classify.js";
import { splitIdentifier } from "./split.js";
import { DEFAULT_WEIGHTS, ROLES, WEIGHT_KEYS, roleOf, structuralSlots, type Role, type Weights } from "./weight.js";

export interface VocabularyOptions {
  readonly view?: View;
  readonly weights?: Weights;
  /** Replaces the shared technical list whole; each profile's own words apply either way. */
  readonly technical?: readonly string[];
  /** Display name for the corpus; defaults to the model roots' basenames. */
  readonly name?: string;
}

/** One scope while it fills; a table row is `[weight, occurrences, carriers]` by interned term. */
interface Tally {
  readonly level: ScopeLevel;
  readonly entity?: Entity;
  entities: number;
  readonly roles: Record<Role, number>;
  readonly skipped: { unnamed: number; conventional: number; numeric: number };
  readonly table: Map<number, [number, number, number]>;
}

/**
 * Count the words of every kept entity's name into the scopes the FOLD puts it
 * in (PLAN.md §20 principle 5): its type (`containingType`), its module
 * (`containingModule`) and the corpus. Pure: the graph is read, never written.
 *
 * Kept is the view's verdict on a non-stub entity. A stub's name is a word
 * another corpus chose (`String`), so stubs never speak, whatever the view.
 * An entity's language is its model's — read from the union, never from its id.
 */
export function buildVocabulary(graph: CodeGraph, options: VocabularyOptions = {}): VocabularyArtifact {
  const view = options.view ?? identityView;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const technical = options.technical ?? DEFAULT_TECHNICAL;
  const folder = folderFor(graph);
  const corpus = corpusOf(graph, options.name);

  const kept: Entity[] = [];
  for (const id of graph.ids()) {
    const entity = graph.entity(id);
    if (entity !== undefined && !graph.isStub(id) && view.entity(entity, graph)) kept.push(entity);
  }

  // --- the scopes: kept modules and types, by trait --------------------
  const root = tally("corpus");
  const modules = new Map<EntityId, Tally>();
  const types = new Map<EntityId, Tally>();
  for (const entity of kept) {
    if (hasTrait(entity, "TModule")) modules.set(entity.id, tally("module", entity));
    else if (hasTrait(entity, "TType")) types.set(entity.id, tally("type", entity));
  }

  // --- the words: one entity at a time, into every scope it folds into ---
  const terms = new Interner();
  const speak = speakerFor(graph, terms, weights, technical);
  const unplaced: EntityId[] = [];
  for (const entity of kept) {
    const module = modules.get(folder.containingModule(entity.id) ?? "");
    const type = types.get(folder.containingType(entity.id) ?? "");
    if (module === undefined) unplaced.push(entity.id);
    speak(entity, [root, ...(module === undefined ? [] : [module]), ...(type === undefined ? [] : [type])]);
  }

  // --- the artifact: terms sorted, scopes indexed, rows remapped --------
  const order = terms.sorted();
  const index = new Map(order.map((term, i) => [term.id, i] as const));
  const tallies = [root, ...sortedById(modules), ...sortedById(types)];
  const scopeIndex = new Map<EntityId, number>();
  tallies.forEach((scope, i) => {
    if (scope.entity !== undefined) scopeIndex.set(scope.entity.id, i);
  });

  const spread = order.map(() => ({ modules: 0, types: 0, exclusive: -1 }));
  const scopes: VocabularyScope[] = tallies.map((scope, i) => {
    const rows = rowsOf(scope, (term) => index.get(term) ?? -1);
    for (const [term] of rows) {
      const counts = spread[term];
      if (counts === undefined || scope.level === "corpus") continue;
      if (scope.level === "type") counts.types += 1;
      else {
        counts.modules += 1;
        counts.exclusive = i;
      }
    }
    return scopeOf(scope, rows, order, parentScope(graph, scope.entity, scopeIndex), corpus.name);
  });

  const words = [...new Set(technical)].sort(compareIds);
  return {
    kind: VOCABULARY_ARTEFACT_KIND,
    generatedBy: VOCABULARY_GENERATOR,
    view: view.descriptor,
    corpus,
    langs: graph.union.langs,
    weights: Object.fromEntries(WEIGHT_KEYS.map((key) => [key, weights[key]])) as Weights,
    classes: TERM_CLASSES,
    technical: { words: words.length, sha256: createHash("sha256").update(words.join("\n"), "utf8").digest("hex") },
    terms: order.map(({ text, class: termClass }, i): VocabularyTerm => {
      const { modules: speaking, types: typed, exclusive } = spread[i] ?? { modules: 0, types: 0, exclusive: -1 };
      return { text, class: termClass, modules: speaking, types: typed, ...(speaking === 1 ? { exclusive } : {}) };
    }),
    scopes,
    diagnostics: {
      unplaced,
      withoutLexicon: graph.union.langs.filter((lang) => getProfile(lang)?.lexicon === undefined),
    },
  };
}

/**
 * AN OPERATION'S WORDS, computed on demand (PLAN.md §20.1; §20.5 keeps them
 * out of the artifact): the operation and every kept entity written inside it,
 * lambdas and their parameters included, short of a type or module, which are
 * scopes of their own. Counted as `buildVocabulary` counts a scope, under the
 * same options, and indexed by the artifact's terms; `undefined` when `id` is
 * no kept operation. An artifact built under other options is refused: its
 * terms would not be this count's.
 */
export function operationScope(
  graph: CodeGraph,
  artifact: VocabularyArtifact,
  id: EntityId,
  options: VocabularyOptions = {},
): OperationScope | undefined {
  const view = options.view ?? identityView;
  const operation = graph.entity(id);
  if (operation === undefined || !isOperation(operation) || graph.isStub(id) || !view.entity(operation, graph)) {
    return undefined;
  }

  const terms = new Interner(artifact.terms);
  const speak = speakerFor(graph, terms, options.weights ?? DEFAULT_WEIGHTS, options.technical ?? DEFAULT_TECHNICAL);
  const scope = tally("corpus", operation);
  const pending: EntityId[] = [id];
  for (let cursor = pending.pop(); cursor !== undefined; cursor = pending.pop()) {
    const entity = graph.entity(cursor);
    if (entity === undefined) continue;
    if (!graph.isStub(cursor) && view.entity(entity, graph)) speak(entity, [scope]);
    for (const child of graph.childrenOf(cursor)) {
      const inner = graph.entity(child);
      if (inner !== undefined && !hasTrait(inner, "TModule") && !hasTrait(inner, "TType")) pending.push(child);
    }
  }
  if (terms.size() !== artifact.terms.length) {
    throw new Error(`operationScope: ${id} speaks words the artifact does not hold — it was built under other options`);
  }

  const scopeIndex = new Map<EntityId, number>();
  artifact.scopes.forEach((stored, i) => {
    if (stored.id !== undefined) scopeIndex.set(stored.id, i);
  });
  const { level: _level, parent: _parent, ...counts } = scopeOf(
    scope,
    rowsOf(scope, (term) => term),
    artifact.terms,
    undefined,
    artifact.corpus.name,
  );
  return {
    ...counts,
    level: "operation",
    id,
    kind: operation.kind,
    parent: parentScope(graph, operation, scopeIndex) ?? 0,
  };
}

/** An invocable that is no scope of its own: a C# delegate, TType + TInvocable, is a type. */
function isOperation(entity: Entity): boolean {
  return hasTrait(entity, "TInvocable") && !hasTrait(entity, "TModule") && !hasTrait(entity, "TType");
}

/**
 * Counts one entity's words into every scope given: its role's weight per
 * word, `qualifier` before the last separator, one carrier per word however
 * often the name says it. The one counting rule of the artifact and of an
 * operation's scope.
 */
function speakerFor(
  graph: CodeGraph,
  terms: Interner,
  weights: Weights,
  technical: readonly string[],
): (entity: Entity, into: readonly Tally[]) => void {
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

  return (entity, into) => {
    for (const scope of into) scope.entities += 1;
    const name = entityName(entity);
    if (name === undefined) {
      for (const scope of into) scope.skipped.unnamed += 1;
      return;
    }
    const lang = langOf.get(entity.id) ?? "";
    const split = splitIdentifier(name, entity.kind, getProfile(lang)?.lexicon);
    if (split.conventional) {
      for (const scope of into) scope.skipped.conventional += 1;
      return;
    }
    const role = roleOf(entity, slots);
    const classify = classifierOf(lang);

    // This entity's own table first: a word it says twice has one carrier.
    const own = new Map<number, [number, number]>();
    split.tokens.forEach((token, i) => {
      const term = terms.intern(token, classify(token));
      const row = own.get(term) ?? [0, 0];
      row[0] += i < split.qualifier ? weights.qualifier : weights[role];
      row[1] += 1;
      own.set(term, row);
    });
    for (const scope of into) {
      scope.skipped.numeric += split.numeric;
      scope.roles[role] += 1;
      for (const [term, [weight, occurrences]] of own) {
        const row = scope.table.get(term) ?? [0, 0, 0];
        row[0] += weight;
        row[1] += occurrences;
        row[2] += 1;
        scope.table.set(term, row);
      }
    }
  };
}

/** A scope's table as rows, by weight descending, then term. */
function rowsOf(scope: Tally, termOf: (interned: number) => number): TermRow[] {
  return [...scope.table]
    .map(([term, [weight, occurrences, carriers]]): TermRow => [termOf(term), weight, occurrences, carriers])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

function tally(level: ScopeLevel, entity?: Entity): Tally {
  return {
    level,
    ...(entity === undefined ? {} : { entity }),
    entities: 0,
    roles: Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>,
    skipped: { unnamed: 0, conventional: 0, numeric: 0 },
    table: new Map(),
  };
}

function sortedById(scopes: ReadonlyMap<EntityId, Tally>): Tally[] {
  return [...scopes].sort(([a], [b]) => compareIds(a, b)).map(([, scope]) => scope);
}

function scopeOf(
  scope: Tally,
  rows: readonly TermRow[],
  terms: readonly { readonly class: TermClass }[],
  parent: number | undefined,
  corpusName: string,
): VocabularyScope {
  const { entity } = scope;
  return {
    level: scope.level,
    ...(entity === undefined ? {} : { id: entity.id }),
    name: entity === undefined ? corpusName : (entityName(entity) ?? entity.id),
    ...(entity === undefined ? {} : { kind: entity.kind }),
    ...(parent === undefined ? {} : { parent }),
    entities: scope.entities,
    roles: scope.roles,
    skipped: scope.skipped,
    distinct: rows.length,
    distinctDomain: rows.filter(([term]) => terms[term]?.class === "domain").length,
    weight: rows.reduce((sum, row) => sum + row[1], 0),
    occurrences: rows.reduce((sum, row) => sum + row[2], 0),
    terms: rows,
  };
}

/** The nearest scope up the containment chain the model writes; the corpus when there is none. */
function parentScope(
  graph: CodeGraph,
  entity: Entity | undefined,
  scopeIndex: ReadonlyMap<EntityId, number>,
): number | undefined {
  if (entity === undefined) return undefined;
  const seen = new Set<EntityId>([entity.id]);
  for (let cursor = graph.parentOf(entity.id); cursor !== undefined && !seen.has(cursor); cursor = graph.parentOf(cursor)) {
    const found = scopeIndex.get(cursor);
    if (found !== undefined) return found;
    seen.add(cursor);
  }
  return 0;
}

/** Each id's language, from the model that declares it first — the graph's own rule. */
function languagesOf(graph: CodeGraph): Map<EntityId, string> {
  const langs = new Map<EntityId, string>();
  for (const model of graph.union.models) {
    for (const entity of model.entities) if (!langs.has(entity.id)) langs.set(entity.id, model.lang);
  }
  return langs;
}

/** Words interned once per (text, class): a class is decided per language. */
class Interner {
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

/**
 * The corpus line of the artifact — the city's and the navigator's rule:
 * deduped, sorted root basenames (or the caller's override), roots verbatim.
 */
function corpusOf(graph: CodeGraph, name: string | undefined): { name: string; roots: readonly string[] } {
  const roots = [...new Set(graph.union.models.map((model) => model.root))]
    .filter((root) => root.length > 0)
    .sort();
  const basenames = [
    ...new Set(
      roots
        .map((root) => root.replace(/\/+$/, ""))
        .map((root) => root.slice(root.lastIndexOf("/") + 1))
        .filter((base) => base.length > 0),
    ),
  ].sort();
  return { name: name ?? (basenames.length > 0 ? basenames.join(" + ") : "codegraph"), roots };
}
