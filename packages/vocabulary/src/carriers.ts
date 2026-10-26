import type { EntityId, SourceAnchor } from "@codegraph/core";
import { compareIds, entityName, folderFor, identityView, type CodeGraph } from "@codegraph/analyzer";
import type { VocabularyOptions } from "./aggregate.js";
import type { ScopeLevel, VocabularyArtifact, VocabularyScope } from "./artifact.js";
import { DEFAULT_TECHNICAL, TERM_CLASSES, type TermClass } from "./classify.js";
import { Interner, keptEntities, readerFor, technicalDigest } from "./reading.js";
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, type Role } from "./weight.js";

/**
 * A SCOPE'S TERM, BACK TO ITS NAMES (PLAN.md §20.2): which entities of a
 * stored scope carry a word, and what each added to the row. The artifact
 * counts and never lists (a list per row would multiply its size by the
 * carriers); this answers one row on demand, from the model a server holds.
 *
 * A ROW IS THE SUM OF ITS CARRIERS. Each entity is read by the artifact's own
 * rule (`reading.ts`) under the artifact's own counting — weights, technical
 * list, view — so the carriers' weights and occurrences add up to the row,
 * and their number is its `carriers`. An artifact counted otherwise is refused.
 *
 * THE NAVIGATOR'S HAND-OFF KEY: a type or a module carries its rendered id,
 * as a navigator node does; a member carries none, and `owner` names the type
 * (else the module) the fold puts it in — the node a page reveals for it.
 */

export const CARRIERS_ANSWER_KIND = "codegraph.carriers/1";

/** How many carriers an answer lists unless asked for another number; `total` always counts them all. */
export const CARRIERS_LIMIT = 200;

export interface Carrier {
  /** The rendered id of a type or a module; absent on a member. Compared, never parsed. */
  readonly id?: string;
  readonly name: string;
  readonly kind: string;
  readonly role: Role;
  /** What this name added to the row. */
  readonly weight: number;
  readonly occurrences: number;
  readonly anchor?: SourceAnchor;
  /** A member's type, else its module: the scope a page reveals it in. */
  readonly owner?: string;
}

export interface CarriersQuery {
  /** A stored scope's id: a module or a type. Absent for the corpus. */
  readonly scope?: string;
  readonly term: string;
  /** Needed only where the scope speaks the text as two terms: two languages class it apart. */
  readonly class?: TermClass;
  /** A whole number >= 0; `CARRIERS_LIMIT` by default. */
  readonly limit?: number;
}

export interface ScopeRef {
  readonly level: ScopeLevel;
  readonly id?: string;
  readonly name: string;
}

export type CarriersAnswer =
  | {
      readonly kind: typeof CARRIERS_ANSWER_KIND;
      readonly status: "found";
      readonly scope: ScopeRef;
      readonly term: { readonly text: string; readonly class: TermClass };
      /** The row: its weight and occurrences, and `total` its carriers. */
      readonly weight: number;
      readonly occurrences: number;
      readonly total: number;
      /** By weight descending, then id; the first `limit`. */
      readonly carriers: readonly Carrier[];
    }
  | { readonly kind: typeof CARRIERS_ANSWER_KIND; readonly status: "unknown-scope"; readonly scope: string }
  | {
      readonly kind: typeof CARRIERS_ANSWER_KIND;
      readonly status: "unknown-term";
      readonly scope: ScopeRef;
      readonly term: string;
      readonly class?: TermClass;
    }
  | {
      readonly kind: typeof CARRIERS_ANSWER_KIND;
      readonly status: "ambiguous";
      readonly scope: ScopeRef;
      readonly term: string;
      readonly classes: readonly TermClass[];
    };

export interface CarrierIndex {
  answer(query: CarriersQuery): CarriersAnswer;
}

/** One kept entity that spoke: who it is, where the fold puts it, what it said. */
interface Speaker {
  readonly id: EntityId;
  readonly carrier: Omit<Carrier, "weight" | "occurrences">;
  /** Indexes into the artifact's scopes; -1 when no stored scope of that level holds it. */
  readonly module: number;
  readonly type: number;
  readonly words: ReadonlyMap<number, readonly [weight: number, occurrences: number]>;
}

/**
 * Read every kept entity once, and answer rows from that. `options` must be
 * the ones `artifact` was built under — the same as `buildVocabulary`'s.
 */
export function vocabularyCarriers(
  graph: CodeGraph,
  artifact: VocabularyArtifact,
  options: VocabularyOptions = {},
): CarrierIndex {
  const view = options.view ?? identityView;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const technical = technicalDigest(options.technical ?? DEFAULT_TECHNICAL);
  if (
    JSON.stringify(view.descriptor) !== JSON.stringify(artifact.view) ||
    WEIGHT_KEYS.some((key) => weights[key] !== artifact.weights[key]) ||
    technical.sha256 !== artifact.technical.sha256
  ) {
    throw new Error("vocabularyCarriers: the artifact was built under other options — its rows are not this count's");
  }

  const modules = new Map<EntityId, number>();
  const types = new Map<EntityId, number>();
  artifact.scopes.forEach((scope, i) => {
    if (scope.id === undefined) return;
    if (scope.level === "module") modules.set(scope.id, i);
    else if (scope.level === "type") types.set(scope.id, i);
  });

  const terms = new Interner(artifact.terms);
  const read = readerFor(graph, terms, weights, options.technical ?? DEFAULT_TECHNICAL);
  const folder = folderFor(graph);
  const speakers: Speaker[] = [];
  for (const entity of keptEntities(graph, view)) {
    const reading = read(entity);
    if (reading.said === "nothing") continue;
    const module = modules.get(folder.containingModule(entity.id) ?? "") ?? -1;
    const type = types.get(folder.containingType(entity.id) ?? "") ?? -1;
    const scope = reading.role === "module" || reading.role === "type";
    const owner = artifact.scopes[type]?.id ?? artifact.scopes[module]?.id;
    const anchor = anchorOf(entity);
    speakers.push({
      id: entity.id,
      carrier: {
        ...(scope ? { id: entity.id } : {}),
        name: entityName(entity) ?? entity.id,
        kind: entity.kind,
        role: reading.role,
        ...(anchor === undefined ? {} : { anchor }),
        ...(scope || owner === undefined ? {} : { owner }),
      },
      module,
      type,
      words: reading.words,
    });
  }
  if (terms.size() !== artifact.terms.length) {
    throw new Error("vocabularyCarriers: the model speaks words the artifact does not hold — it was built from another model");
  }

  const scopeIndex = new Map<string, number>([...modules, ...types]);
  return {
    answer(query) {
      const limit = query.limit ?? CARRIERS_LIMIT;
      if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`a carriers limit is a whole number >= 0, not ${limit}`);
      const at = query.scope === undefined ? 0 : (scopeIndex.get(query.scope) ?? -1);
      const scope = artifact.scopes[at];
      if (scope === undefined) return { kind: CARRIERS_ANSWER_KIND, status: "unknown-scope", scope: query.scope ?? "" };
      const ref = refOf(scope);

      const rows = scope.terms.filter(([term]) => {
        const entry = artifact.terms[term];
        return entry?.text === query.term && (query.class === undefined || entry.class === query.class);
      });
      const [row, ...others] = rows;
      if (row === undefined) {
        return {
          kind: CARRIERS_ANSWER_KIND,
          status: "unknown-term",
          scope: ref,
          term: query.term,
          ...(query.class === undefined ? {} : { class: query.class }),
        };
      }
      if (others.length > 0) {
        const classes = rows.map(([term]) => artifact.terms[term]?.class).filter((cls): cls is TermClass => cls !== undefined);
        return {
          kind: CARRIERS_ANSWER_KIND,
          status: "ambiguous",
          scope: ref,
          term: query.term,
          classes: TERM_CLASSES.filter((cls) => classes.includes(cls)),
        };
      }

      const [term, weight, occurrences, total] = row;
      const found: { readonly id: EntityId; readonly carrier: Carrier }[] = [];
      for (const speaker of speakers) {
        if (at !== 0 && speaker.module !== at && speaker.type !== at) continue;
        const said = speaker.words.get(term);
        if (said !== undefined) found.push({ id: speaker.id, carrier: { ...speaker.carrier, weight: said[0], occurrences: said[1] } });
      }
      found.sort((a, b) => b.carrier.weight - a.carrier.weight || compareIds(a.id, b.id));
      return {
        kind: CARRIERS_ANSWER_KIND,
        status: "found",
        scope: ref,
        term: { text: query.term, class: artifact.terms[term]?.class ?? "domain" },
        weight,
        occurrences,
        total,
        carriers: found.slice(0, limit).map(({ carrier }) => carrier),
      };
    },
  };
}

function refOf(scope: VocabularyScope): ScopeRef {
  return { level: scope.level, ...(scope.id === undefined ? {} : { id: scope.id }), name: scope.name };
}

function anchorOf(entity: object): SourceAnchor | undefined {
  const anchor = (entity as { anchor?: { file?: unknown; span?: unknown } }).anchor;
  if (typeof anchor?.file !== "string" || !Array.isArray(anchor.span) || anchor.span.length !== 2) return undefined;
  const [start, end] = anchor.span as unknown[];
  return typeof start === "number" && typeof end === "number" ? { file: anchor.file, span: [start, end] } : undefined;
}
