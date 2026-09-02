import type { EntityId } from "@codegraph/core";
import {
  condense,
  hasTrait,
  identityView,
  importGraph,
  sortIds,
  typeDependencyGraph,
  type CodeGraph,
  type View,
} from "@codegraph/analyzer";
import type { Level } from "./schema.js";
import type { UnitSet } from "./units.js";

/**
 * THE WALK ORDER. Every unit is explained after everything it depends on, so
 * its prompt can carry their explanations instead of their source:
 *
 *   operation → the operation units it calls (corpus calls only; a field
 *               access is context, never an ordering edge — fields are not units)
 *   type      → the types it depends on (the analyzer's type dependency graph),
 *               its operation units, and the types nested inside it
 *   module    → the modules it imports (the analyzer's import graph), and its
 *               types. A parent PACKAGE is not a dependency of its children nor
 *               they of it: containment between modules is a namespace fact,
 *               not a "depends on" relation, so it never orders or merges.
 *
 * ONE RULE AT EVERY LEVEL: a strongly connected group is ONE unit — mutually
 * recursive methods, a type cycle, mutually dependent packages — explained
 * together, its members listed on every record. Cross-level edges only point
 * downward (type → operation, module → type), so a unit never mixes levels.
 *
 * The condensation is acyclic; Kahn layering over it (dependencies first, ties
 * by component order) makes the sequence deterministic and lets a scheduler run
 * one layer's units concurrently.
 */

export interface Unit {
  /** The first member's id — unique, because an entity belongs to exactly one unit. */
  readonly id: string;
  readonly level: Level;
  /** Sorted; length ≥ 2 means a dependency cycle. */
  readonly members: readonly EntityId[];
  /** Unit ids this unit depends on, sorted. */
  readonly deps: readonly string[];
  /** 0 for a unit with no dependencies; 1 + max over deps otherwise. */
  readonly layer: number;
}

export interface WalkPlan {
  /** Dependencies first: `units[i].deps` all appear before index i. */
  readonly units: readonly Unit[];
  readonly layers: readonly (readonly Unit[])[];
  /** Entity id → the unit that carries it. */
  readonly unitOf: ReadonlyMap<EntityId, Unit>;
}

/** The dependency edges the walk orders by, per entity — exported so tests can inspect the raw graph. */
export function dependencyEdges(
  units: UnitSet,
  graph: CodeGraph,
  view: View = identityView,
): ReadonlyMap<EntityId, readonly EntityId[]> {
  const out = new Map<EntityId, Set<EntityId>>();
  const add = (from: EntityId, to: EntityId): void => {
    if (from === to) return;
    const bucket = out.get(from);
    if (bucket === undefined) out.set(from, new Set([to]));
    else bucket.add(to);
  };
  for (const id of units.operations.keys()) out.set(id, new Set());
  for (const id of units.types.keys()) out.set(id, new Set());
  for (const id of units.modules.keys()) out.set(id, new Set());

  for (const unit of units.operations.values()) {
    for (const call of unit.fact.invocations) {
      if (call.external) continue;
      const target = units.enclosingOperation(call.to);
      if (target !== undefined) add(unit.id, target);
    }
  }

  const typeDeps = typeDependencyGraph(graph, view);
  for (const [id, dossier] of units.types) {
    for (const edge of typeDeps.outgoing(id)) {
      if (!edge.selfLoop && units.types.has(edge.to)) add(id, edge.to);
    }
    for (const op of dossier.operations) if (units.operations.has(op.id)) add(id, op.id);
    for (const child of graph.childrenOf(id)) {
      const entity = graph.entity(child);
      if (entity !== undefined && hasTrait(entity, "TType") && units.types.has(child)) add(id, child);
    }
  }

  const imports = importGraph(graph, view);
  for (const [id, module] of units.modules) {
    for (const edge of imports.outgoing(id)) {
      if (!edge.selfLoop && units.modules.has(edge.to)) add(id, edge.to);
    }
    for (const type of module.types) if (units.types.has(type)) add(id, type);
  }

  return new Map([...out].map(([id, set]) => [id, sortIds([...set])]));
}

/** A binary min-heap of component indexes — Kahn's ready set with a deterministic pop. */
class MinHeap {
  readonly #items: number[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(value: number): void {
    const items = this.#items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((items[parent] ?? 0) <= (items[i] ?? 0)) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): number {
    const items = this.#items;
    const top = items[0] ?? 0;
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && (items[l] ?? 0) < (items[m] ?? 0)) m = l;
        if (r < items.length && (items[r] ?? 0) < (items[m] ?? 0)) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

export function buildWalk(units: UnitSet, graph: CodeGraph, view: View = identityView): WalkPlan {
  const edges = dependencyEdges(units, graph, view);
  const nodes = sortIds([...edges.keys()]);
  const condensation = condense(nodes, (id) => edges.get(id) ?? []);
  const { components, successors } = condensation;

  // Kahn on the REVERSED condensation: a component is ready once every
  // component it depends on has been emitted.
  const pending = successors.map((s) => s.length);
  const dependents: number[][] = components.map(() => []);
  successors.forEach((succ, from) => {
    for (const to of succ) dependents[to]?.push(from);
  });
  const layerOf: number[] = components.map(() => 0);
  const ready = new MinHeap();
  pending.forEach((count, index) => {
    if (count === 0) ready.push(index);
  });
  const order: number[] = [];
  while (ready.size > 0) {
    const index = ready.pop();
    order.push(index);
    for (const dependent of dependents[index] ?? []) {
      layerOf[dependent] = Math.max(layerOf[dependent] ?? 0, (layerOf[index] ?? 0) + 1);
      pending[dependent] = (pending[dependent] ?? 0) - 1;
      if (pending[dependent] === 0) ready.push(dependent);
    }
  }
  if (order.length !== components.length) {
    throw new Error("insights: the condensation is not acyclic — this is a bug in the SCC step");
  }

  const unitIdOf = (index: number): string => components[index]?.[0] ?? "";
  const built: Unit[] = components.map((members, index) => {
    const first = members[0] ?? "";
    const level = units.levelOf(first);
    if (level === undefined) throw new Error(`insights: ${first} belongs to no unit level`);
    return {
      id: first,
      level,
      members,
      deps: sortIds((successors[index] ?? []).map(unitIdOf)),
      layer: layerOf[index] ?? 0,
    };
  });

  // Walk order: by layer, then by component order (= first member id).
  const ordered = order.map((index) => built[index]!);
  ordered.sort((a, b) => a.layer - b.layer || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const layers: Unit[][] = [];
  const unitOf = new Map<EntityId, Unit>();
  for (const unit of ordered) {
    (layers[unit.layer] ??= []).push(unit);
    for (const member of unit.members) unitOf.set(member, unit);
  }
  return { units: ordered, layers, unitOf };
}
