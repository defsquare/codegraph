import type { NavigatorModel } from "@codegraph/navigator";
import type { PackageFold } from "./fold.js";

/**
 * The virtualized tree renders a FLAT array of the currently visible rows —
 * derived from the artifact's preorder tree, the package fold and the
 * expansion state, pure and cheap enough to recompute on every toggle (one
 * DFS over visible nodes only). Row ids are FOLDED ids: a real node index, or
 * `nodes.length + g` for synthetic package group `g`.
 */
export interface TreeRow {
  readonly node: number;
  readonly depth: number;
  readonly expandable: boolean;
}

export function visibleRows(
  model: NavigatorModel,
  fold: PackageFold,
  expanded: ReadonlySet<number>,
  options: { readonly hideExternals?: boolean } = {},
): readonly TreeRow[] {
  const hideExternals = options.hideExternals === true;
  const total = model.nodes.length;
  const rows: TreeRow[] = [];
  const stack: { node: number; depth: number }[] = [];
  const pushChildren = (children: readonly number[], depth: number): void => {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i] as number, depth });
    }
  };
  pushChildren(fold.roots, 0);
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: number; depth: number };
    if (node >= total) {
      const group = fold.groups[node - total];
      if (group === undefined) continue;
      if (hideExternals && group.allStub) continue;
      rows.push({ node, depth, expandable: group.children.length > 0 });
      if (expanded.has(node)) pushChildren(group.children, depth + 1);
      continue;
    }
    const entry = model.nodes[node];
    if (entry === undefined) continue;
    if (hideExternals && entry.isStub) continue;
    const adopted = fold.extraChildren.get(node);
    rows.push({
      node,
      depth,
      expandable: entry.children.length > 0 || (adopted !== undefined && adopted.length > 0),
    });
    if (!expanded.has(node)) continue;
    // Adopted modules render FIRST — same rank the builder gives modules.
    pushChildren(entry.children, depth + 1);
    if (adopted !== undefined) pushChildren(adopted, depth + 1);
  }
  return rows;
}

/** The expansion set that makes `node` visible: all its folded ancestors, expanded. */
export function expandedToReveal(
  model: NavigatorModel,
  fold: PackageFold,
  expanded: ReadonlySet<number>,
  node: number,
): ReadonlySet<number> {
  const next = new Set(expanded);
  let cursor = node;
  for (;;) {
    // A re-parented root module (or a group) has no model parent; the fold
    // knows where it hangs.
    const parent = model.nodes[cursor]?.parent ?? fold.parentOf.get(cursor);
    if (parent === undefined) break;
    next.add(parent);
    cursor = parent;
  }
  return next;
}
