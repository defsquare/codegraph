/**
 * THE TWO HELPER VIEWS, DEFINED ONCE (PLAN.md §24.4).
 *
 * The store keeps natural keys and surrogates (MM-1); a person writing SQL
 * wants the rendered id every report prints and an edge with its names
 * resolved. `node` and `dep` give both. They are TEMP views: they live in the
 * connection that creates them and never in the store, so a read-only handle
 * holds them and the cache's bytes do not change.
 *
 * This text is what `codegraph query` creates, what `codegraph query --views`
 * prints for another SQLite client, and what the documentation shows — the
 * CLI's `helper-views-docs.test.ts` holds the copies in `docs/` and `website/`
 * equal to it. Change a view here, and those pages in the same commit.
 *
 * `node.id` restates `renderId` in SQL, with the one hazard `ids.ts` names:
 * "is this entity its own module?" is `e.id = e.module_id`, never a comparison
 * of symbols. `store-helper-views.test.ts` checks it against the analyzer's
 * own ids on every language's fixture and on a namesake corpus.
 *
 * Named `helper-views`, not `views`: `src/views.ts` is the pipeline's
 * predicate views (`internalOnly`, `declaredOnly`), a different thing.
 */

import type { SqliteDatabase } from "./sqlite.js";

/** One row per entity: the surrogate, the rendered id, the kind and name, and where it sits. */
export const NODE_VIEW_SQL = `CREATE TEMP VIEW node AS
SELECT e.id                                          AS ref,
       (SELECT value FROM meta WHERE key = 'lang') || ':' || m.symbol
         -- no '/' for a module (it names itself) nor for an empty symbol (an anonymous function)
         || CASE WHEN e.id = e.module_id OR e.symbol = '' THEN '' ELSE '/' || e.symbol END
         || CASE WHEN e.disambiguator IS NULL THEN '' ELSE '#' || e.disambiguator END
                                                     AS id,
       k.name                                        AS kind,
       e.name                                        AS name,
       -- \`IS 1\`, not \`= 1\`: a non-stubbable entity has NULL here, and \`= 1\`
       -- would make every comparison NULL and quietly drop every method.
       e.is_stub IS 1                                AS is_stub,
       e.module_id                                   AS module_ref,
       e.parent_id                                   AS parent_ref,
       e.trait_set_id                                AS trait_set_id
  FROM entity e
  JOIN entity m ON m.id = e.module_id
  JOIN kind   k ON k.id = e.kind_id;`;

/** One row per edge: its two ends by surrogate, its kind and provenance by name, its anchor. */
export const DEP_VIEW_SQL = `CREATE TEMP VIEW dep AS
SELECT x.id            AS ref,
       x.from_id       AS from_ref,
       x.to_id         AS to_ref,
       ek.name         AS kind,
       p.name          AS provenance,
       f.path          AS file,
       x.anchor_start  AS line
  FROM edge x
  JOIN edge_kind  ek ON ek.id = x.kind_id
  JOIN provenance p  ON p.id  = x.provenance_id
  JOIN file       f  ON f.id  = x.anchor_file_id;`;

/** Both statements, in the order to run them — the text `codegraph query --views` prints. */
export const HELPER_VIEWS_SQL = `${NODE_VIEW_SQL}\n\n${DEP_VIEW_SQL}\n`;

/**
 * Create `node` and `dep` in this connection's temp schema.
 *
 * Once per connection: a second call throws SQLite's own "view node already
 * exists", which is a caller's bug and not a state to paper over.
 */
export function createHelperViews(db: SqliteDatabase): void {
  db.exec(HELPER_VIEWS_SQL);
}
