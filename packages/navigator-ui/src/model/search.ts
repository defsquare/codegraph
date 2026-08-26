/**
 * Substring search over the precomputed lowercase keys — one linear scan, no
 * index structure: even a 240k-node corpus is a few milliseconds, and the
 * result cap keeps the DOM small long before the scan becomes the cost.
 */
export const SEARCH_LIMIT = 200;

export interface SearchResult {
  readonly matches: readonly number[];
  /** True when more rows matched than `matches` carries. */
  readonly truncated: boolean;
}

export function searchNodes(
  searchKeys: readonly string[],
  query: string,
  limit = SEARCH_LIMIT,
): SearchResult {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { matches: [], truncated: false };
  const matches: number[] = [];
  for (let i = 0; i < searchKeys.length; i += 1) {
    if (!(searchKeys[i] as string).includes(needle)) continue;
    if (matches.length >= limit) return { matches, truncated: true };
    matches.push(i);
  }
  return { matches, truncated: false };
}
