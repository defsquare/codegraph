/**
 * Deterministic ordering (PLAN.md §6, analyzer decision 6). Every output —
 * folded graphs, metric tables, SCC lists, exports — is sorted with these, so
 * Map/Set iteration order never decides what a user sees or what a test
 * compares. Ids are opaque: they are compared as strings, never parsed.
 */

/** Total order on ids/strings by UTF-16 code unit — locale-independent. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted copy; the input is never mutated. */
export function sortIds<T extends string>(ids: Iterable<T>): T[] {
  return [...ids].sort(compareIds);
}

/** Sorted copy with duplicates removed — the shape every derived index exposes. */
export function sortedUnique<T extends string>(ids: Iterable<T>): T[] {
  return [...new Set(ids)].sort(compareIds);
}

/** Lexicographic order on a pair of ids, for edge tables keyed (from, to). */
export function comparePairs(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  return compareIds(a[0], b[0]) || compareIds(a[1], b[1]);
}
