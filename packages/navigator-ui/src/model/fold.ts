import type { NavigatorModel } from "@codegraph/navigator";

/**
 * PACKAGE FOLDING — presentation only. The artifact's tree nests modules as
 * the MODEL declares them, and Java extractors declare packages flat, so a
 * corpus arrives with hundreds of `org.apache.fineract.*` roots. This layer
 * folds those roots by their dotted display names, IDE-style:
 *
 *   - roots sharing a prefix hang under one synthetic group (`jakarta`);
 *   - module-less single-child segments collapse into one label
 *     (`org` › `apache` › `fineract` becomes `org.apache.fineract`);
 *   - a module whose name is another's prefix adopts it (`a.b.c` under `a.b`).
 *
 * No graph fact is derived — groups own no dependencies, carry no metrics and
 * are not selectable; they only shape the rows the tree shows. Splitting a
 * display NAME is not parsing an id (invariant 7 concerns identity, which
 * never reaches this renderer).
 *
 * Folded ids share the tree's number space: a real node keeps its index, group
 * `g` is `nodes.length + g` — so the expansion set, scroll targets and the
 * virtualized walk stay plain numbers.
 */
export interface FoldGroup {
  /** Segments relative to the parent row, joined — the row's display label. */
  readonly label: string;
  /** Folded ids, sorted by first segment; never empty. */
  readonly children: readonly number[];
  /** True when every module under the group is a stub — externals filtering. */
  readonly allStub: boolean;
}

export interface PackageFold {
  /** Folded ids replacing `model.roots`: grouped modules first, the rest verbatim. */
  readonly roots: readonly number[];
  readonly groups: readonly FoldGroup[];
  /** Display label for a real module shown under a folded prefix (relative name). */
  readonly labels: ReadonlyMap<number, string>;
  /** Folded children PREPENDED to a real module's own — modules it adopted. */
  readonly extraChildren: ReadonlyMap<number, readonly number[]>;
  /** Folded parent of every re-parented folded id — the reveal path. */
  readonly parentOf: ReadonlyMap<number, number>;
}

export function isGroupId(model: NavigatorModel, id: number): boolean {
  return id >= model.nodes.length;
}

interface TrieNode {
  /** Root modules whose full name ends at this segment (>1 only on collision). */
  readonly modules: number[];
  readonly children: Map<string, TrieNode>;
}

const newTrieNode = (): TrieNode => ({ modules: [], children: new Map() });

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function foldPackages(model: NavigatorModel): PackageFold {
  const groups: FoldGroup[] = [];
  const labels = new Map<number, string>();
  const extraChildren = new Map<number, readonly number[]>();
  const parentOf = new Map<number, number>();

  const trie = newTrieNode();
  const others: number[] = [];
  for (const root of model.roots) {
    const node = model.nodes[root];
    if (node === undefined) continue;
    if (node.category !== "module") {
      others.push(root);
      continue;
    }
    let cursor = trie;
    for (const segment of node.name.split(".")) {
      let child = cursor.children.get(segment);
      if (child === undefined) {
        child = newTrieNode();
        cursor.children.set(segment, child);
      }
      cursor = child;
    }
    cursor.modules.push(root);
  }

  const sortedChildren = (node: TrieNode): readonly [string, TrieNode][] =>
    [...node.children.entries()].sort((a, b) => compareStrings(a[0], b[0]));

  /**
   * Emit one folded row for a trie subtree. `path` is the segment chain since
   * the parent ROW (not the tree root) — it becomes the row's relative label.
   */
  const emit = (start: TrieNode, startPath: readonly string[]): { id: number; allStub: boolean } => {
    let node = start;
    const path = [...startPath];
    // Compact middle packages: a segment holding no module and exactly one
    // child is never worth a row of its own.
    while (node.modules.length === 0 && node.children.size === 1) {
      const [segment, child] = [...node.children.entries()][0] as [string, TrieNode];
      path.push(segment);
      node = child;
    }
    const label = path.join(".");

    if (node.modules.length === 1) {
      // The module IS the row; deeper trie entries become its adopted children.
      const id = node.modules[0] as number;
      const name = model.nodes[id]?.name;
      if (label !== name) labels.set(id, label);
      let allStub = model.nodes[id]?.isStub === true;
      const adopted: number[] = [];
      for (const [segment, child] of sortedChildren(node)) {
        const emitted = emit(child, [segment]);
        adopted.push(emitted.id);
        parentOf.set(emitted.id, id);
        allStub = allStub && emitted.allStub;
      }
      if (adopted.length > 0) extraChildren.set(id, adopted);
      return { id, allStub };
    }

    // No single module ends here — a synthetic group row. Colliding same-name
    // modules (>1) become its direct children, ahead of the deeper prefixes.
    const groupId = model.nodes.length + groups.length;
    groups.push({ label, children: [], allStub: false }); // placeholder: children need groupId
    let allStub = true;
    const children: number[] = [];
    for (const id of node.modules) {
      children.push(id);
      parentOf.set(id, groupId);
      const name = model.nodes[id]?.name;
      if (label !== name) labels.set(id, label);
      allStub = allStub && model.nodes[id]?.isStub === true;
    }
    for (const [segment, child] of sortedChildren(node)) {
      const emitted = emit(child, [segment]);
      children.push(emitted.id);
      parentOf.set(emitted.id, groupId);
      allStub = allStub && emitted.allStub;
    }
    groups[groupId - model.nodes.length] = { label, children, allStub };
    return { id: groupId, allStub };
  };

  const roots = sortedChildren(trie).map(([segment, child]) => emit(child, [segment]).id);

  // Models that DECLARE package nesting repeat the parent's prefix in the
  // child's name (`com.acme.order` › `com.acme.order.adapter`); fold that
  // repetition out of the label too — the containment itself stands untouched.
  for (const [index, node] of model.nodes.entries()) {
    if (node.category !== "module" || node.parent === undefined) continue;
    const parent = model.nodes[node.parent];
    if (parent?.category !== "module") continue;
    const prefix = `${parent.name}.`;
    if (node.name.startsWith(prefix) && node.name.length > prefix.length) {
      labels.set(index, node.name.slice(prefix.length));
    }
  }

  return { roots: [...roots, ...others], groups, labels, extraChildren, parentOf };
}
