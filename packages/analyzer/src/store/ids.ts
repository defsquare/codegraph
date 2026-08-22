/**
 * Surrogate → rendered `EntityId`, in ONE place.
 *
 * The store keeps natural keys (MM-1); everything above the store speaks
 * rendered ids. Reconstructing one turns on a single question — is this entity
 * its own module? — and the tempting cheap answer, "does its symbol equal its
 * module's symbol?", is wrong for any type whose symbol happens to match its
 * module's path: it renders the type as its own package, collapsing two
 * entities onto one id. Only `module_id === id` means "this record names
 * itself".
 *
 * That hazard survived a full parity suite once (step 7, mutation F4), which is
 * why the reconstruction lives here rather than being written out at each call
 * site. Two copies would be two chances to make it, and the second copy would
 * be the one nobody wrote a namesake fixture for.
 */

import { renderId, type EntityId, type NaturalKey } from "@codegraph/core";

import type { SqliteDatabase, SqliteValue } from "./sqlite.js";

/** The model's language, from `meta`. Part of every natural key. */
export function storeLang(db: SqliteDatabase): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'lang'").get();
  return (row?.value as string | undefined) ?? "";
}

/**
 * Rendered ids for the entities a `WHERE` clause selects, keyed by surrogate.
 *
 * `where` is interpolated, not bound: every caller passes a fragment it built
 * itself from column names and integers — never user input — and a prepared
 * parameter cannot stand in for a predicate. Pass `"1"` for all of them.
 */
export function renderStoreIds(
  db: SqliteDatabase,
  lang: string,
  where: string,
): Map<number, EntityId> {
  const statement = db.prepare(
    `SELECT e.id, m.symbol, e.symbol, e.disambiguator, e.module_id
       FROM entity e JOIN entity m ON m.id = e.module_id
      WHERE ${where}
      ORDER BY e.id`,
  );
  statement.setReturnArrays(true);

  const out = new Map<number, EntityId>();
  for (const row of statement.iterate() as unknown as Iterable<SqliteValue[]>) {
    const [id, moduleSymbol, symbol, disambiguator, moduleId] = row as [
      number,
      string,
      string,
      string | null,
      number,
    ];
    const key: NaturalKey = {
      lang,
      module: moduleSymbol,
      // A module names ITSELF (`m === i` on the wire): its symbol slot holds
      // the module path and its key's symbol is empty. See the file comment.
      symbol: id === moduleId ? "" : symbol,
      ...(disambiguator === null ? {} : { disambiguator }),
    };
    out.set(id, renderId(key));
  }
  return out;
}
