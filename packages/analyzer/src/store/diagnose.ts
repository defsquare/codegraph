/**
 * DIAGNOSTICS FROM THE STORE (PLAN.md §9.3).
 *
 * `loadDecodedModels` spends 1.3s of a fineract command on profile validation
 * and 0.8s on closure. Both answers are already in the database, and one of
 * them is nearly free there — which is the point of this file: the store is not
 * asked to REMEMBER a diagnosis, it is asked to answer one. A cached verdict
 * inside a cache is a second thing to invalidate; a query is not.
 *
 * ── Why this is cheap, and it is MM-4 that makes it so ───────────────────
 *
 * Profile validity is a function of `(kind, trait set, isStub)` — nothing about
 * the entity carrying them enters into it. The store INTERNS trait sets, so
 * `SELECT DISTINCT kind_id, trait_set_id, is_stub` is 23 rows over fineract's
 * 241 101 entities, and each verdict is decided once by
 * `entityCompositionVerdict` — the same memoized function `validateEntity`
 * calls, so the two cannot disagree about a composition.
 *
 * Better still, a verdict with no issues needs no entities at all. On a clean
 * corpus this enumerates nothing: only the compositions that DO have something
 * wrong get their entities listed and their ids rendered.
 *
 * The same trick covers the rest. `edge-kind-not-allowed` is a function of the
 * edge kind — six distinct values. Self-edges, duplicate identities and the
 * space licence are single GROUP BY queries.
 *
 * ── The one check this does not run, and why ─────────────────────────────
 *
 * `validateEntity` also parses each declared trait's keys with Zod, per entity
 * — 1.2M parses on fineract, and the bulk of that 1.3s. It is skipped here
 * because it cannot fail on a model that came through the store: the record
 * reader enforces `WIRE_TRAITS` on every entity at import (step 3), and
 * `WIRE_TRAITS` is `TRAITS` with ids replaced by surrogates and paths by file
 * references. A key the wire rejected never reached a row.
 *
 * That is an argument, so it is also a test: `store-diagnose.test.ts` pins that
 * every trait's key set matches between the two tables and that a violating
 * value is refused on the wire, and the parity suite compares whole diagnostics
 * against the in-memory path on models broken in each category.
 */

import {
  PROVENANCES,
  entityCompositionVerdict,
  getProfile,
  selfReferences,
  type Model,
  type Profile,
} from "@codegraph/core";

import type { LoadDiagnostics, ProfileIssue } from "../load.js";
import { compareIds } from "../order.js";
import { hydrateModel } from "./import.js";
import { renderStoreIds, storeLang } from "./ids.js";
import type { SqliteDatabase } from "./sqlite.js";

export interface DiagnoseStoreOptions {
  /** The label diagnostics carry — the model's path, as the CLI reports it. */
  readonly label?: string;
  /** The argument position, when the store stands in for one of several inputs. */
  readonly modelIndex?: number;
  /**
   * How to materialize the model, for the one diagnostic that needs whole
   * `Edge` objects. Called only when a self-edge exists, which on a conforming
   * corpus is never. Defaults to hydrating this store.
   */
  readonly model?: () => Model;
}

/**
 * An issue and where it belongs in the emitted order.
 *
 * `validateModel` emits per entity in model order, and within one entity in a
 * fixed order, then every edge issue after all of them. The array IS the
 * report, so reproducing it means reproducing that order — `position` is the
 * entity surrogate (its index in the model), `rank` orders the issues one
 * entity contributes.
 */
interface Placed {
  readonly position: number;
  readonly rank: number;
  readonly issue: Omit<ProfileIssue, "modelIndex" | "label" | "lang">;
}

/** Ranks, in the order `validateEntity` and `validateModel` emit them. */
const RANK = { composition: 0, space: 1, duplicate: 2 } as const;

/** Edges are reported after every entity, so they sort past any surrogate. */
const AFTER_ENTITIES = Number.MAX_SAFE_INTEGER;

function rows<T>(db: SqliteDatabase, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function names(db: SqliteDatabase, table: string): string[] {
  const out: string[] = [];
  for (const row of rows<{ id: number; name: string }>(db, `SELECT id, name FROM ${table}`)) {
    out[row.id] = row.name;
  }
  return out;
}

/**
 * The diagnosis for the model in this store, in the shape `loadDecodedModels`
 * produces for the same model.
 *
 * `schemaErrors` and `danglingReferences` are always empty, and that is a
 * property rather than an omission: nothing reaches a store without passing the
 * record reader, which refuses a malformed record and refuses a reference that
 * resolves to no entity. A store IS a model that already loaded.
 */
export function diagnoseStore(
  db: SqliteDatabase,
  options: DiagnoseStoreOptions = {},
): LoadDiagnostics {
  const lang = storeLang(db);
  const label = options.label ?? "model.db";
  const modelIndex = options.modelIndex ?? 0;
  const profile = getProfile(lang);

  const model = options.model ?? ((): Model => hydrateModel(db));
  const selfEdges = selfEdgesOf(db, modelIndex, label, model);
  const placed: Placed[] = [];

  if (profile === undefined) {
    // No profile: the model is NOT validated but is still analyzed, the same
    // choice the in-memory path makes. Duplicate identities are not a profile
    // question — they are computed over the union either way — so they are
    // still reported, and `placed` is left alone because the `duplicate-entity-id`
    // ISSUE is a profile finding while the duplicate itself is not.
    return {
      schemaErrors: [],
      profileIssues: [],
      profileIssueCounts: Object.create(null) as Record<string, number>,
      unknownProfiles: [lang],
      danglingReferences: [],
      selfEdges,
      duplicateIds: collectDuplicates(db, lang, modelIndex, undefined),
    };
  }

  if (lang !== profile.lang) {
    placed.push({
      position: -1,
      rank: 0,
      issue: {
        code: "profile-lang-mismatch",
        path: "lang",
        message: `model declares lang "${lang}" but was validated against profile "${profile.lang}"`,
      },
    });
  }

  collectCompositionIssues(db, profile, lang, placed);
  collectSpaceIssues(db, profile, lang, placed);
  const duplicateIds = collectDuplicates(db, lang, modelIndex, placed);
  collectEdgeIssues(db, profile, placed);

  placed.sort((a, b) => a.position - b.position || a.rank - b.rank);

  const profileIssues: ProfileIssue[] = placed.map((entry) => ({
    modelIndex,
    label,
    lang,
    ...entry.issue,
  }));

  const profileIssueCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const issue of profileIssues) {
    profileIssueCounts[issue.code] = (profileIssueCounts[issue.code] ?? 0) + 1;
  }

  return {
    schemaErrors: [],
    profileIssues,
    profileIssueCounts,
    unknownProfiles: [],
    danglingReferences: [],
    selfEdges,
    duplicateIds,
  };
}

/**
 * One verdict per distinct `(kind, trait set, isStub)` — 23 of them on
 * fineract. Only the compositions that HAVE issues cost anything beyond the
 * verdict itself.
 */
function collectCompositionIssues(
  db: SqliteDatabase,
  profile: Profile,
  lang: string,
  placed: Placed[],
): void {
  const kindNames = names(db, "kind");
  const traitNames = names(db, "trait");

  const traitsBySet = new Map<number, string[]>();
  for (const row of rows<{ trait_set_id: number; trait_id: number }>(
    db,
    "SELECT trait_set_id, trait_id FROM trait_set_member ORDER BY trait_set_id, ord",
  )) {
    const list = traitsBySet.get(row.trait_set_id);
    if (list === undefined) traitsBySet.set(row.trait_set_id, [traitNames[row.trait_id]!]);
    else list.push(traitNames[row.trait_id]!);
  }

  const compositions = rows<{ kind_id: number; trait_set_id: number; is_stub: number | null }>(
    db,
    "SELECT DISTINCT kind_id, trait_set_id, is_stub FROM entity",
  );

  for (const composition of compositions) {
    const kind = kindNames[composition.kind_id] ?? "";
    const traits = traitsBySet.get(composition.trait_set_id) ?? [];
    // `isStubEntity` is "declares TType or TModule AND isStub === true" — the
    // TRAIT half matters. A record carrying `isStub` without either trait is
    // not a stub in memory, and the column alone would say it is.
    const stubbable = traits.includes("TType") || traits.includes("TModule");
    const verdict = entityCompositionVerdict(
      profile,
      kind,
      traits,
      stubbable && composition.is_stub === 1,
    );
    if (verdict.issues.length === 0) continue;

    // Only now does anything touch entities — and only the ones affected.
    const where =
      `e.kind_id = ${composition.kind_id} AND e.trait_set_id = ${composition.trait_set_id}` +
      ` AND e.is_stub IS ${composition.is_stub === null ? "NULL" : composition.is_stub}`;
    for (const [surrogate, id] of renderStoreIds(db, lang, where)) {
      for (const issue of verdict.issues) {
        placed.push({
          position: surrogate,
          rank: RANK.composition,
          issue: { code: issue.code, path: id, message: issue.message },
        });
      }
    }
  }
}

/**
 * The type/value split is TypeScript-family only. `space` is absent from every
 * entity no current extractor emits, so this normally selects nothing at all —
 * and when it does, the licence is a function of `(kind, space)`.
 */
function collectSpaceIssues(
  db: SqliteDatabase,
  profile: Profile,
  lang: string,
  placed: Placed[],
): void {
  const kindNames = names(db, "kind");
  const groups = rows<{ kind_id: number; space: string }>(
    db,
    "SELECT DISTINCT kind_id, space FROM entity WHERE space IS NOT NULL",
  );

  for (const group of groups) {
    const kind = kindNames[group.kind_id] ?? "";
    const licensed =
      profile.space !== undefined && Object.hasOwn(profile.space, kind)
        ? new Set<string>(profile.space[kind])
        : new Set<string>();
    const offending = (JSON.parse(group.space) as string[]).filter((one) => !licensed.has(one));
    if (offending.length === 0) continue;

    const where = `e.kind_id = ${group.kind_id} AND e.space = ${quote(group.space)}`;
    for (const [surrogate, id] of renderStoreIds(db, lang, where)) {
      for (const space of offending) {
        placed.push({
          position: surrogate,
          rank: RANK.space,
          issue: {
            code: "space-not-allowed",
            path: id,
            message: `space "${space}" is not licensed for kind "${kind}" by profile "${profile.lang}"`,
          },
        });
      }
    }
  }
}

/**
 * Ids declared more than once. Legal when the declarations AGREE (declaration
 * merging, partial classes) and a finding when they do not — so the query
 * groups by natural key and the disagreement is on `(kind_id, trait_set_id)`,
 * which is precisely `sameDeclaration`'s test with the trait set already
 * interned for us.
 */
function collectDuplicates(
  db: SqliteDatabase,
  lang: string,
  modelIndex: number,
  /** Undefined when no profile applies: the duplicate is still a fact, the ISSUE is not. */
  placed: Placed[] | undefined,
): LoadDiagnostics["duplicateIds"] {
  const groups = rows<{ module_id: number; symbol: string; disambiguator: string | null }>(
    db,
    `SELECT module_id, symbol, disambiguator FROM entity
      GROUP BY module_id, symbol, ifnull(disambiguator, char(0))
     HAVING count(*) > 1`,
  );
  if (groups.length === 0) return [];

  const kindNames = names(db, "kind");
  const declarationKey = canonicalTraitKeys(db);
  const duplicates: LoadDiagnostics["duplicateIds"][number][] = [];

  for (const group of groups) {
    const where =
      `e.module_id = ${group.module_id} AND e.symbol = ${quote(group.symbol)} AND ` +
      (group.disambiguator === null
        ? "e.disambiguator IS NULL"
        : `e.disambiguator = ${quote(group.disambiguator)}`);

    const members = rows<{ id: number; kind_id: number; trait_set_id: number }>(
      db,
      `SELECT id, kind_id, trait_set_id FROM entity e WHERE ${where} ORDER BY id`,
    );
    const first = members[0]!;
    const id = renderStoreIds(db, lang, where).get(first.id)!;

    let conflicting = false;
    for (const member of members.slice(1)) {
      // `sameDeclaration` compares kind and the trait SET — so two entities
      // whose interned sets differ only in ORDER agree. Comparing
      // `trait_set_id` would call that a conflict; the canonical key does not.
      const same =
        member.kind_id === first.kind_id &&
        declarationKey[member.trait_set_id] === declarationKey[first.trait_set_id];
      if (same) continue;
      if (!conflicting && placed !== undefined) {
        // Reported once per id, at the first disagreeing entity's position — a
        // triple redeclaration must not count twice against a code bucket.
        placed.push({
          position: member.id,
          rank: RANK.duplicate,
          issue: {
            code: "duplicate-entity-id",
            path: id,
            message:
              `id redeclared with a different kind or trait set ` +
              `("${kindNames[first.kind_id]}" vs "${kindNames[member.kind_id]}")`,
          },
        });
      }
      conflicting = true;
    }
    duplicates.push({ id, occurrences: members.length, modelIndexes: [modelIndex], conflicting });
  }

  return duplicates.sort((a, b) => compareIds(a.id, b.id));
}

/** Per trait set, `sameDeclaration`'s view of it: unique, sorted, NUL-joined. */
function canonicalTraitKeys(db: SqliteDatabase): string[] {
  const traitNames = names(db, "trait");
  const bySet = new Map<number, string[]>();
  for (const row of rows<{ trait_set_id: number; trait_id: number }>(
    db,
    "SELECT trait_set_id, trait_id FROM trait_set_member",
  )) {
    const list = bySet.get(row.trait_set_id);
    if (list === undefined) bySet.set(row.trait_set_id, [traitNames[row.trait_id]!]);
    else list.push(traitNames[row.trait_id]!);
  }
  const out: string[] = [];
  for (const [setId, traits] of bySet) {
    out[setId] = [...new Set(traits)].sort().join("\u0000");
  }
  return out;
}

/** `edge-kind-not-allowed` is a function of the kind: six values, not 782 046. */
function collectEdgeIssues(db: SqliteDatabase, profile: Profile, placed: Placed[]): void {
  const licensed = new Set<string>(profile.edges);
  const edgeKindNames = names(db, "edge_kind");
  const provenanceNames = names(db, "provenance");

  const offending = [...edgeKindNames.entries()].filter(
    ([, name]) => name !== undefined && !licensed.has(name),
  );
  const badProvenance = [...provenanceNames.entries()].filter(
    ([, name]) => name !== undefined && !(PROVENANCES as readonly string[]).includes(name),
  );
  if (offending.length === 0 && badProvenance.length === 0) return;

  const clause =
    (offending.length > 0 ? `x.kind_id IN (${offending.map(([id]) => id).join(",")})` : "0") +
    (badProvenance.length > 0
      ? ` OR x.provenance_id IN (${badProvenance.map(([id]) => id).join(",")})`
      : "");

  // `path` is `edges[i]`, so the edge's POSITION is what identifies it — which
  // the importer stored as `edge.id`.
  for (const row of rows<{ id: number; kind_id: number; provenance_id: number }>(
    db,
    `SELECT id, kind_id, provenance_id FROM edge x WHERE ${clause} ORDER BY id`,
  )) {
    const path = `edges[${row.id}]`;
    if (badProvenance.some(([id]) => id === row.provenance_id)) {
      placed.push({
        position: AFTER_ENTITIES,
        rank: row.id * 2,
        issue: {
          code: "missing-provenance",
          path,
          message: `edge has no valid provenance`,
        },
      });
    }
    if (offending.some(([id]) => id === row.kind_id)) {
      placed.push({
        position: AFTER_ENTITIES,
        rank: row.id * 2 + 1,
        issue: {
          code: "edge-kind-not-allowed",
          path,
          message: `edge kind "${edgeKindNames[row.kind_id]}" is not emitted by profile "${profile.lang}"`,
        },
      });
    }
  }
}

/**
 * `from === to`, which the model forbids (METAMODEL §4).
 *
 * The count is one query. Building the diagnostic is not, because `SelfEdge`
 * carries the whole `Edge` — so when one exists, the model is hydrated and
 * core's own `selfReferences` answers. A deliberate trade: a self-edge means
 * the corpus is already broken and the user is about to be told so, and paying
 * a hydrate on that path costs nothing on every correct one. Rebuilding an
 * `Edge` from columns here would be a second edge constructor, drifting from
 * `ModelBuilder`'s for the sake of a case that should not exist.
 */
function selfEdgesOf(
  db: SqliteDatabase,
  modelIndex: number,
  label: string,
  model: () => Model,
): LoadDiagnostics["selfEdges"] {
  const count = db.prepare("SELECT count(*) AS n FROM edge WHERE from_id = to_id").get();
  if (Number(count?.n ?? 0) === 0) return [];
  return selfReferences(model()).map((self) => ({
    modelIndex,
    label,
    path: self.path,
    edge: self.edge,
  }));
}

/** SQL string literal. Only ever called with values read back out of this database. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
