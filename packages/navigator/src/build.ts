import type { Entity, EntityId } from "@codegraph/core";
import {
  coupling,
  folderFor,
  hasTrait,
  identityView,
  importGraph,
  includesEdge,
  typeDependencyGraph,
  type CodeGraph,
  type CouplingRow,
  type View,
} from "@codegraph/analyzer";
import {
  NAVIGATOR_ARTEFACT_KIND,
  NAVIGATOR_GENERATOR,
  type DepRow,
  type NavAnchor,
  type NavNode,
  type NavigatorModel,
  type NodeCategory,
} from "./model.js";
import { classifyEdge } from "./roles.js";

export interface NavigatorOptions {
  readonly view?: View;
  /** Display name for the corpus; defaults to the model roots' basenames. */
  readonly name?: string;
}

/**
 * Build the navigator model. Pure: the graph is read, nothing is written back.
 *
 * Selection and containment are decided from TRAITS and the model's own
 * `parent` chain — never from `kind` strings (profile-specific) and never by
 * splitting a name or an id (CLAUDE.md invariant 7). The tree is:
 *
 *   module   TModule; nested under the nearest ancestor module the model declares
 *   type     TType; under the nearest ancestor type, else its containing module
 *   operation  TInvocable members, FLAT under their containing type (lambdas
 *              included) — the same flattening the city's `operations` list uses
 *   attribute  TStructural entities declared directly in a type or module; the
 *              parent check is what excludes parameters and locals, whose
 *              parent is the invocable
 */
export function buildNavigator(
  graph: CodeGraph,
  options: NavigatorOptions = {},
): NavigatorModel {
  const view = options.view ?? identityView;
  const folder = folderFor(graph);

  // --- selection: which entities become tree nodes, and their category -----
  const categories = new Map<EntityId, NodeCategory>();
  for (const id of graph.ids()) {
    const entity = graph.entity(id);
    if (entity === undefined || !view.entity(entity, graph)) continue;
    const category = categoryOf(graph, entity);
    if (category !== undefined) categories.set(id, category);
  }

  // --- tree parents, resolved against the SELECTED set ---------------------
  const treeParent = new Map<EntityId, EntityId>();
  const childrenOf = new Map<EntityId, EntityId[]>();
  const roots: EntityId[] = [];
  for (const [id, category] of categories) {
    const parent = treeParentOf(graph, folder, categories, id, category);
    if (parent === undefined) {
      roots.push(id);
      continue;
    }
    treeParent.set(id, parent);
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) childrenOf.set(parent, [id]);
    else bucket.push(id);
  }

  // --- preorder index assignment, children sorted (category, name, id) -----
  const order = childOrder(graph, categories);
  roots.sort(order);
  for (const bucket of childrenOf.values()) bucket.sort(order);
  const preorder: EntityId[] = [];
  const indexOf = new Map<EntityId, number>();
  const stack: EntityId[] = [...roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as EntityId;
    indexOf.set(id, preorder.length);
    preorder.push(id);
    const children = childrenOf.get(id);
    if (children !== undefined) for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as EntityId);
  }

  // --- coupling metrics, at each category's own fold level ------------------
  const typeRows = rowsById(coupling(typeDependencyGraph(graph, view)).rows);
  const moduleRows = rowsById(coupling(importGraph(graph, view)).rows);

  // --- emit nodes, interning anchor files as they appear --------------------
  const files: string[] = [];
  const fileIndex = new Map<string, number>();
  const internFile = (path: string): number => {
    const existing = fileIndex.get(path);
    if (existing !== undefined) return existing;
    fileIndex.set(path, files.length);
    files.push(path);
    return files.length - 1;
  };

  const nodes: NavNode[] = preorder.map((id) => {
    const entity = graph.entity(id) as Entity;
    const category = categories.get(id) as NodeCategory;
    const parent = treeParent.get(id);
    const parentIndex = parent === undefined ? undefined : indexOf.get(parent);
    const signature = stringKey(entity, "signature");
    const declared = stringKey(entity, "declaredType");
    const declaredIndex = declared === undefined ? undefined : indexOf.get(declared);
    const anchor = anchorOf(entity, internFile);
    const metrics =
      category === "type"
        ? typeRows.get(id)
        : category === "module"
          ? moduleRows.get(id)
          : undefined;
    return {
      name: stringKey(entity, "name") ?? signature ?? id,
      kind: entity.kind,
      category,
      isStub: graph.isStub(id),
      ...(parentIndex === undefined ? {} : { parent: parentIndex }),
      children: (childrenOf.get(id) ?? []).map((child) => indexOf.get(child) as number),
      ...(signature === undefined ? {} : { signature }),
      ...(declaredIndex === undefined ? {} : { declaredType: declaredIndex }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(metrics === undefined ? {} : { metrics: { fanIn: metrics.fanIn, fanOut: metrics.fanOut } }),
    };
  });

  // --- dependency rows ------------------------------------------------------
  const deps: DepRow[] = [];
  let selfDeps = 0;
  let droppedDeps = 0;
  for (const edge of graph.edges) {
    if (!includesEdge(view, graph, edge)) continue;
    const from = ownerAndMember(graph, categories, indexOf, edge.from);
    const to = ownerAndMember(graph, categories, indexOf, edge.to);
    if (from === undefined || to === undefined) {
      droppedDeps += 1;
      continue;
    }
    if (from.owner === to.owner) {
      selfDeps += 1;
      continue;
    }
    const anchor: NavAnchor = [internFile(edge.anchor.file), edge.anchor.span[0], edge.anchor.span[1]];
    for (const classified of classifyEdge(graph, edge)) {
      deps.push({
        role: classified.role,
        from: from.owner,
        to: to.owner,
        ...(from.member === undefined ? {} : { member: from.member }),
        ...(to.member === undefined ? {} : { toMember: to.member }),
        ...(classified.detail === undefined ? {} : { detail: classified.detail }),
        provenance: edge.provenance,
        anchor,
      });
    }
  }
  deps.sort(compareDeps);

  return {
    kind: NAVIGATOR_ARTEFACT_KIND,
    generatedBy: NAVIGATOR_GENERATOR,
    view: view.descriptor,
    corpus: corpusOf(graph, options.name),
    files,
    nodes,
    roots: roots.map((id) => indexOf.get(id) as number),
    deps,
    diagnostics: { selfDeps, droppedDeps },
  };
}

/** Trait precedence decides the category; entities with none are not tree nodes. */
function categoryOf(graph: CodeGraph, entity: Entity): NodeCategory | undefined {
  if (hasTrait(entity, "TModule")) return "module";
  if (hasTrait(entity, "TType")) return "type";
  if (hasTrait(entity, "TInvocable")) return "operation";
  if (hasTrait(entity, "TStructural")) {
    // Parameters and locals also carry TStructural; their parent is the
    // invocable, which is what excludes them here (city's isAttributeOf rule).
    const parent = graph.parentOf(entity.id);
    const parentEntity = parent === undefined ? undefined : graph.entity(parent);
    if (parentEntity === undefined) return undefined;
    return hasTrait(parentEntity, "TType") || hasTrait(parentEntity, "TModule")
      ? "attribute"
      : undefined;
  }
  return undefined;
}

/** Nearest strict ancestor (via the model's `parent` chain) passing `keep`. */
function nearestAncestor(
  graph: CodeGraph,
  id: EntityId,
  keep: (candidate: EntityId) => boolean,
): EntityId | undefined {
  const seen = new Set<EntityId>([id]);
  let cursor = graph.parentOf(id);
  while (cursor !== undefined && !seen.has(cursor)) {
    if (keep(cursor)) return cursor;
    seen.add(cursor);
    cursor = graph.parentOf(cursor);
  }
  return undefined;
}

function treeParentOf(
  graph: CodeGraph,
  folder: ReturnType<typeof folderFor>,
  categories: ReadonlyMap<EntityId, NodeCategory>,
  id: EntityId,
  category: NodeCategory,
): EntityId | undefined {
  const selectedAs = (wanted: NodeCategory) => (candidate: EntityId) =>
    categories.get(candidate) === wanted;
  if (category === "module") return nearestAncestor(graph, id, selectedAs("module"));
  if (category === "type") {
    return (
      nearestAncestor(graph, id, selectedAs("type")) ??
      nearestAncestor(graph, id, selectedAs("module"))
    );
  }
  // Operations and attributes hang FLAT under their containing type — the
  // folder's walk, so a lambda inside a method lands on the type, exactly as
  // the city's members list does — else under their containing module.
  const type = folder.containingType(id);
  if (type !== undefined && categories.get(type) === "type") return type;
  const module = folder.containingModule(id);
  if (module !== undefined && categories.get(module) === "module") return module;
  return undefined;
}

const CATEGORY_RANK: Readonly<Record<NodeCategory, number>> = {
  module: 0,
  type: 1,
  operation: 2,
  attribute: 3,
};

/** Code-unit compare — the workspace's one string order. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function childOrder(
  graph: CodeGraph,
  categories: ReadonlyMap<EntityId, NodeCategory>,
): (a: EntityId, b: EntityId) => number {
  const label = (id: EntityId): string => {
    const entity = graph.entity(id);
    return entity === undefined
      ? id
      : (stringKey(entity, "name") ?? stringKey(entity, "signature") ?? id);
  };
  return (a, b) =>
    CATEGORY_RANK[categories.get(a) as NodeCategory] -
      CATEGORY_RANK[categories.get(b) as NodeCategory] ||
    compareStrings(label(a), label(b)) ||
    compareStrings(a, b);
}

interface OwnedEndpoint {
  readonly owner: number;
  readonly member?: number;
}

/**
 * The selectable nodes owning one edge endpoint: the nearest type/module-
 * category ancestor (self included) is the OWNER; the first operation/
 * attribute node passed on the way (the endpoint itself, for a method or a
 * field) is the carrying MEMBER. A parameter or local variable resolves
 * through its invocable to the same pair, so its edges attribute to the
 * operation that declares it.
 */
function ownerAndMember(
  graph: CodeGraph,
  categories: ReadonlyMap<EntityId, NodeCategory>,
  indexOf: ReadonlyMap<EntityId, number>,
  id: EntityId,
): OwnedEndpoint | undefined {
  let member: number | undefined;
  const seen = new Set<EntityId>();
  let cursor: EntityId | undefined = id;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const category = categories.get(cursor);
    if (category !== undefined) {
      const index = indexOf.get(cursor);
      if (index !== undefined) {
        if (category === "type" || category === "module") {
          return { owner: index, ...(member === undefined ? {} : { member }) };
        }
        if (member === undefined) member = index;
      }
    }
    cursor = graph.parentOf(cursor);
  }
  return undefined;
}

function compareDeps(a: DepRow, b: DepRow): number {
  return (
    a.from - b.from ||
    a.to - b.to ||
    compareStrings(a.role, b.role) ||
    (a.member ?? -1) - (b.member ?? -1) ||
    (a.toMember ?? -1) - (b.toMember ?? -1) ||
    a.anchor[0] - b.anchor[0] ||
    a.anchor[1] - b.anchor[1] ||
    a.anchor[2] - b.anchor[2] ||
    compareStrings(a.provenance, b.provenance)
  );
}

function rowsById(rows: readonly CouplingRow[]): ReadonlyMap<EntityId, CouplingRow> {
  return new Map(rows.map((row) => [row.id, row] as const));
}

function stringKey(entity: Entity, key: string): string | undefined {
  const value = (entity as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function anchorOf(entity: Entity, internFile: (path: string) => number): NavAnchor | undefined {
  const anchor = (entity as { anchor?: { file?: string; span?: [number, number] } }).anchor;
  if (anchor?.file === undefined || anchor.span === undefined) return undefined;
  return [internFile(anchor.file), anchor.span[0], anchor.span[1]];
}

/**
 * The corpus line of the artefact — same rule as the city's: deduped, sorted
 * root basenames (or the caller's override) for display, roots verbatim.
 */
function corpusOf(
  graph: CodeGraph,
  name: string | undefined,
): { name: string; roots: readonly string[] } {
  const roots = [...new Set(graph.union.models.map((model) => model.root))]
    .filter((root) => root.length > 0)
    .sort();
  const basenames = [
    ...new Set(
      roots
        .map((root) => root.replace(/\/+$/, ""))
        .map((root) => root.slice(root.lastIndexOf("/") + 1))
        .filter((base) => base.length > 0),
    ),
  ].sort();
  return { name: name ?? (basenames.length > 0 ? basenames.join(" + ") : "codegraph"), roots };
}
