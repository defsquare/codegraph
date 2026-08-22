/**
 * FOLDING, PUSHED DOWN INTO SQL (PLAN.md §9.3).
 *
 * `foldGraph` is the funnel of the whole pipeline: every report and every
 * export consumes a `FoldedGraph`, and nothing downstream looks at the base
 * model. So this is the one place worth moving — answer the fold in SQL and
 * coupling, cycles, DOT, PlantUML, CSV and JSON all get it for free, with no
 * change to any of them.
 *
 * WHY NOT JUST HYDRATE. Step 6 measured it: rebuilding the whole `Model` from
 * the store costs 3.6s on fineract against 6.4s to read the text — a 1.8×
 * constant. Folding in SQL never brings the 782 046 base edges into JavaScript
 * at all; only the ~20 000 aggregated ones cross. Measured on fineract at
 * module level: **0.38s to resolve containers, 0.51s to aggregate**, against
 * ~7.6s for decode + buildGraph + fold.
 *
 * IT REFUSES RATHER THAN APPROXIMATES. A view is an arbitrary JavaScript
 * predicate pair; SQL cannot run one. What SQL can do is translate the ones the
 * view NAMES — `internalOnly`, `declaredOnly`, `provenance:…` — through
 * `ViewDescriptor.filters`. Anything else returns `undefined`, and the caller
 * hydrates and folds in memory. A facade that quietly answered a slightly
 * different question would be worse than no facade: the numbers would still
 * look like numbers.
 *
 * ONE MODEL. A store holds one model; `loadModels` may union several. This
 * answers for the store's model alone, so a multi-model analysis is one of the
 * cases the caller must not use it for.
 */

import type { EdgeKind, Provenance } from "@codegraph/core";

import {
  assembleFoldedGraph,
  type FoldLevel,
  type FoldOptions,
  type FoldedEdge,
  type FoldedGraph,
  type FoldedNode,
} from "../fold.js";
import { identityView, type ViewDescriptor } from "../views.js";
import { renderStoreIds, storeLang } from "./ids.js";
import type { SqliteDatabase, SqliteValue } from "./sqlite.js";

/** The trait that makes an entity a container at each level — mirrors `fold.ts`. */
const LEVEL_TRAIT: Readonly<Record<FoldLevel, string>> = {
  type: "TType",
  module: "TModule",
};

/**
 * A view translated to SQL, or the reason it could not be.
 *
 * `entity` constrains an entity row (alias bound by the caller); `edge`
 * constrains an edge row. Both are complete predicates — `"1"` when the view
 * imposes nothing.
 */
interface ViewSql {
  readonly entity: (alias: string) => string;
  readonly edge: (alias: string) => string;
}

function provenanceIds(db: SqliteDatabase, names: readonly string[]): number[] | undefined {
  const ids: number[] = [];
  for (const name of names) {
    const row = db.prepare("SELECT id FROM provenance WHERE name = ?").get(name);
    // A provenance the model never uses is not an error — the view simply
    // matches nothing — but it must still translate to a valid predicate.
    if (row !== undefined) ids.push(row.id as number);
  }
  return ids;
}

/**
 * Translate a view by the filters it declares. Returns `undefined` for any
 * filter this module does not recognise, which is the whole safety story: an
 * unrecognised view is answered in memory, not approximated here.
 */
export function translateView(db: SqliteDatabase, view: ViewDescriptor): ViewSql | undefined {
  const entity: string[] = [];
  const edge: string[] = [];

  for (const filter of view.filters) {
    if (filter === "internalOnly") {
      // `isStubEntity` is "declares TType or TModule AND isStub === true", and
      // the wire only carries `isStub` for those traits — so `is_stub = 1` is
      // exactly that predicate, and NULL is simply "not a stub".
      entity.push("{}.is_stub IS NOT 1");
      continue;
    }
    if (filter === "declaredOnly") {
      const ids = provenanceIds(db, ["declared"]);
      edge.push(`{}.provenance_id IN (${ids?.join(",") || "NULL"})`);
      continue;
    }
    if (filter.startsWith("provenance:")) {
      const names = filter.slice("provenance:".length).split(",").filter((n) => n !== "");
      const ids = provenanceIds(db, names);
      edge.push(`{}.provenance_id IN (${ids?.join(",") || "NULL"})`);
      continue;
    }
    return undefined; // A predicate only JavaScript knows.
  }

  const bind = (parts: string[]) => (alias: string) =>
    parts.length === 0 ? "1" : parts.map((part) => part.replaceAll("{}", alias)).join(" AND ");
  return { entity: bind(entity), edge: bind(edge) };
}

/** `count(*)` for a statement that returns exactly one row. */
function scalar(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get();
  return Number(Object.values(row ?? { n: 0 })[0] ?? 0);
}

/**
 * Resolve every entity to its nearest self-or-ancestor carrying the level's
 * trait, into `temp.container`.
 *
 * A FIXPOINT, not a recursive CTE. Measured on fineract: the CTE costs 1.06s
 * against 0.38s for these few rounds, because it re-walks each chain from every
 * descendant while this resolves a whole depth per pass. Seven or eight rounds
 * cover a Java corpus; the loop ends when a pass adds nothing, so a malformed
 * parent CYCLE terminates too — its members simply never resolve, which is the
 * same answer the in-memory walk gives.
 *
 * The walk deliberately ignores the view. `foldGraph` walks the FULL graph and
 * filters afterwards, so an internal class inside a stub package must still
 * resolve to that package before the view rejects it.
 */
function resolveContainers(db: SqliteDatabase, level: FoldLevel): void {
  const traitSets = db
    .prepare(
      "SELECT DISTINCT m.trait_set_id AS s FROM trait_set_member m" +
        " JOIN trait t ON t.id = m.trait_id WHERE t.name = ?",
    )
    .all(LEVEL_TRAIT[level])
    .map((row) => row.s as number);

  db.exec("DROP TABLE IF EXISTS temp.container");
  db.exec("CREATE TEMP TABLE container(id INTEGER PRIMARY KEY, container_id INTEGER NOT NULL)");

  // No trait set carries the level trait: nothing is a container, and every
  // entity is unfoldable. The IN () below would be a syntax error, so stop.
  if (traitSets.length === 0) return;
  const isContainer = `trait_set_id IN (${traitSets.join(",")})`;

  db.exec(`INSERT INTO temp.container SELECT id, id FROM entity WHERE ${isContainer}`);
  for (;;) {
    const before = scalar(db, "SELECT count(*) FROM temp.container");
    db.exec(
      `INSERT OR IGNORE INTO temp.container(id, container_id)
         SELECT e.id, c.container_id
           FROM entity e JOIN temp.container c ON c.id = e.parent_id
          WHERE e.id NOT IN (SELECT id FROM temp.container)`,
    );
    if (scalar(db, "SELECT count(*) FROM temp.container") === before) return;
  }
}

/**
 * Fold the store's model to `level` under `options.view`, entirely in SQL.
 *
 * @returns the identical `FoldedGraph` `foldGraph` would produce, or
 * `undefined` when the view names a filter this module cannot translate.
 */
export function foldFromStore(db: SqliteDatabase, options: FoldOptions): FoldedGraph | undefined {
  const view = options.view ?? identityView;
  const sql = translateView(db, view.descriptor);
  if (sql === undefined) return undefined;

  const lang = storeLang(db);

  resolveContainers(db, options.level);

  // Entities the view keeps, mapped to containers the view also keeps. An
  // entity whose container is excluded is UNFOLDABLE, not folded onto itself.
  db.exec("DROP TABLE IF EXISTS temp.placed");
  db.exec(
    `CREATE TEMP TABLE placed(id INTEGER PRIMARY KEY, container_id INTEGER NOT NULL);
     INSERT INTO temp.placed
       SELECT c.id, c.container_id
         FROM temp.container c
         JOIN entity e ON e.id = c.id
         JOIN entity ce ON ce.id = c.container_id
        WHERE ${sql.entity("e")} AND ${sql.entity("ce")};`,
  );

  const kinds =
    options.edgeKinds === undefined
      ? undefined
      : db
          .prepare(
            `SELECT id FROM edge_kind WHERE name IN (${options.edgeKinds.map(() => "?").join(",")})`,
          )
          .all(...(options.edgeKinds as unknown as SqliteValue[]))
          .map((row) => row.id as number);

  /**
   * Edges the view keeps: its own edge predicate, plus both endpoints surviving
   * the ENTITY predicate — `includesEdge`'s rule, which is why the endpoints are
   * checked here and not only in the aggregation.
   *
   * The entity joins are skipped when the view constrains no entity. Under
   * `all` and `declaredOnly` that removes two joins from every pass over
   * 782 046 rows, and adding them "for uniformity" would be paying for a
   * predicate that is the constant true.
   */
  const filtersEntities = sql.entity("ef") !== "1";
  const entityJoins = filtersEntities
    ? " JOIN entity ef ON ef.id = x.from_id JOIN entity et ON et.id = x.to_id"
    : "";
  const where =
    `WHERE ${sql.edge("x")}` +
    (filtersEntities ? ` AND ${sql.entity("ef")} AND ${sql.entity("et")}` : "") +
    (kinds === undefined ? "" : ` AND x.kind_id IN (${kinds.join(",") || "NULL"})`);

  /**
   * Both totals in ONE pass. `droppedEdges` is "in the view but an endpoint has
   * no container", so it needs the in-view count and the placed count — two
   * separate scans of the edge table would be a third of this function's time
   * for an arithmetic difference.
   */
  const totals = db
    .prepare(
      `SELECT count(*) AS in_view,
              sum(CASE WHEN pf.id IS NOT NULL AND pt.id IS NOT NULL THEN 1 ELSE 0 END) AS placed
         FROM edge x${entityJoins}
         LEFT JOIN temp.placed pf ON pf.id = x.from_id
         LEFT JOIN temp.placed pt ON pt.id = x.to_id
        ${where}`,
    )
    .get();
  const inViewTotal = Number(totals?.in_view ?? 0);
  const placedTotal = Number(totals?.placed ?? 0);

  // THE ONE QUERY THAT MATTERS: 782 046 base edges become ~20 000 aggregated
  // ones without a single base edge crossing into JavaScript.
  const selfLoopFilter =
    options.dropSelfLoops === true ? " AND pf.container_id != pt.container_id" : "";
  const aggregate = db.prepare(
    `SELECT pf.container_id, pt.container_id, count(*),
            group_concat(DISTINCT x.kind_id), group_concat(DISTINCT x.provenance_id)
       FROM edge x${entityJoins}
       JOIN temp.placed pf ON pf.id = x.from_id
       JOIN temp.placed pt ON pt.id = x.to_id
      ${where}${selfLoopFilter}
      GROUP BY pf.container_id, pt.container_id`,
  );
  aggregate.setReturnArrays(true);

  const edgeKindNames = dictionary(db, "edge_kind");
  const provenanceNames = dictionary(db, "provenance");

  const nodeIds = renderStoreIds(
    db,
    lang,
    "e.id IN (SELECT DISTINCT container_id FROM temp.placed)",
  );

  const rawEdges: [number, number, number, string, string][] = [];
  for (const row of aggregate.iterate() as unknown as Iterable<SqliteValue[]>) {
    rawEdges.push(row as unknown as [number, number, number, string, string]);
  }

  const edges: FoldedEdge[] = rawEdges.map(([from, to, count, kindList, provList]) => ({
    from: nodeIds.get(from)!,
    to: nodeIds.get(to)!,
    count,
    kinds: new Set(kindList.split(",").map((id) => edgeKindNames[Number(id)]!)) as ReadonlySet<EdgeKind>,
    provenances: new Set(
      provList.split(",").map((id) => provenanceNames[Number(id)]!),
    ) as ReadonlySet<Provenance>,
    selfLoop: from === to,
  }));

  const kindNames = dictionary(db, "kind");
  const nodes: FoldedNode[] = [];
  const memberRows = db.prepare(
    `SELECT p.container_id, count(*), e.kind_id, e.name, e.is_stub
       FROM temp.placed p JOIN entity e ON e.id = p.container_id
      GROUP BY p.container_id`,
  );
  memberRows.setReturnArrays(true);
  for (const row of memberRows.iterate() as unknown as Iterable<SqliteValue[]>) {
    const [container, members, kindId, name, isStub] = row as [
      number,
      number,
      number,
      string | null,
      number | null,
    ];
    nodes.push({
      id: nodeIds.get(container)!,
      kind: kindNames[kindId] ?? "unknown",
      name: name ?? undefined,
      isStub: isStub === 1,
      members,
    });
  }

  // Entities the view keeps that no view-kept container claims.
  const unfoldableIds = renderStoreIds(
    db,
    lang,
    `${sql.entity("e")} AND e.id NOT IN (SELECT id FROM temp.placed)`,
  );

  db.exec("DROP TABLE IF EXISTS temp.placed");
  db.exec("DROP TABLE IF EXISTS temp.container");

  return assembleFoldedGraph(options.level, view.descriptor, nodes, edges, {
    unfoldableEntities: [...unfoldableIds.values()],
    droppedEdges: inViewTotal - placedTotal,
    foldedEdges: edges.reduce((sum, edge) => sum + edge.count, 0),
  });
}

/** `id → name` for one of the interned vocabularies. */
function dictionary(db: SqliteDatabase, table: string): string[] {
  const out: string[] = [];
  for (const row of db.prepare(`SELECT id, name FROM ${table}`).iterate()) {
    out[row.id as number] = row.name as string;
  }
  return out;
}
