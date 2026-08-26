import type { NavigatorModel } from "@codegraph/navigator";

/**
 * The virtualized tree renders a FLAT array of the currently visible rows —
 * derived from the artifact's preorder tree and the expansion state, pure and
 * cheap enough to recompute on every toggle (one DFS over visible nodes only).
 */
export interface TreeRow {
  readonly node: number;
  readonly depth: number;
  readonly expandable: boolean;
}

export function visibleRows(
  model: NavigatorModel,
  expanded: ReadonlySet<number>,
  options: { readonly hideExternals?: boolean } = {},
): readonly TreeRow[] {
  const hideExternals = options.hideExternals === true;
  const rows: TreeRow[] = [];
  const stack: { node: number; depth: number }[] = [];
  for (let i = model.roots.length - 1; i >= 0; i -= 1) {
    stack.push({ node: model.roots[i] as number, depth: 0 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: number; depth: number };
    const entry = model.nodes[node];
    if (entry === undefined) continue;
    if (hideExternals && entry.isStub) continue;
    rows.push({ node, depth, expandable: entry.children.length > 0 });
    if (!expanded.has(node)) continue;
    for (let i = entry.children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: entry.children[i] as number, depth: depth + 1 });
    }
  }
  return rows;
}

/** The expansion set that makes `node` visible: all its ancestors, expanded. */
export function expandedToReveal(
  model: NavigatorModel,
  expanded: ReadonlySet<number>,
  node: number,
): ReadonlySet<number> {
  const next = new Set(expanded);
  let cursor = model.nodes[node]?.parent;
  while (cursor !== undefined) {
    next.add(cursor);
    cursor = model.nodes[cursor]?.parent;
  }
  return next;
}
