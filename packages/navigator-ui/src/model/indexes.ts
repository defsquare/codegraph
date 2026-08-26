import type { NavigatorModel } from "@codegraph/navigator";

/**
 * The renderer's lookup maps over the artifact's flat arrays — derived in the
 * browser, per session, never serialized. Building these is the "indexing"
 * phase of the loading pipeline; on a real corpus it is one linear pass over
 * the dep rows and one over the nodes.
 *
 * NO GRAPH FACT IS DERIVED HERE (CLAUDE.md hard boundary): roles, owners,
 * members and coupling numbers all arrive precomputed; these maps only answer
 * "which precomputed rows touch node N".
 */
export interface ModelIndexes {
  readonly model: NavigatorModel;
  /** Dep-row indexes by owning source node (types and modules). */
  readonly depsByFrom: ReadonlyMap<number, readonly number[]>;
  /** Dep-row indexes by owning target node. */
  readonly depsByTo: ReadonlyMap<number, readonly number[]>;
  /** Dep-row indexes by carrying source member (operations and attributes). */
  readonly depsByMember: ReadonlyMap<number, readonly number[]>;
  /** Dep-row indexes by carrying target member. */
  readonly depsByToMember: ReadonlyMap<number, readonly number[]>;
  /** Lowercased `name signature`, aligned with `model.nodes` — the search corpus. */
  readonly searchKeys: readonly string[];
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

export function buildIndexes(model: NavigatorModel): ModelIndexes {
  const depsByFrom = new Map<number, number[]>();
  const depsByTo = new Map<number, number[]>();
  const depsByMember = new Map<number, number[]>();
  const depsByToMember = new Map<number, number[]>();
  for (const [index, dep] of model.deps.entries()) {
    push(depsByFrom, dep.from, index);
    push(depsByTo, dep.to, index);
    if (dep.member !== undefined) push(depsByMember, dep.member, index);
    if (dep.toMember !== undefined) push(depsByToMember, dep.toMember, index);
  }
  const searchKeys = model.nodes.map((node) =>
    node.signature === undefined
      ? node.name.toLowerCase()
      : `${node.name} ${node.signature}`.toLowerCase(),
  );
  return { model, depsByFrom, depsByTo, depsByMember, depsByToMember, searchKeys };
}

/** Ancestor chain of a node, root first — the breadcrumb, and the reveal path. */
export function ancestorsOf(model: NavigatorModel, node: number): readonly number[] {
  const chain: number[] = [];
  let cursor = model.nodes[node]?.parent;
  while (cursor !== undefined) {
    chain.push(cursor);
    cursor = model.nodes[cursor]?.parent;
  }
  return chain.reverse();
}
