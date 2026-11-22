import type { EntityId } from "@codegraph/core";
import { compileSelector, folderFor, type CodeGraph, type Selector, type SelectorMatcher, type View } from "@codegraph/analyzer";
import type { Unit, WalkPlan } from "./order.js";
import { trivialKindOf } from "./plan.js";
import { LEVELS, type Level } from "./schema.js";
import type { WalkSpec } from "./spec.js";
import type { UnitSet } from "./units.js";

/**
 * THE SELECTION (PLAN.md §22.3): which units a walk ASKS. The walk itself is
 * filter-blind — units, order and fingerprints are built over the whole model
 * (`buildWalk`, `collectUnits` know nothing of this file) — and a selection
 * resolves to the `inScope` predicate `planRun` has always taken. What it
 * leaves out is `skip-scope`, the existing status with its existing meaning.
 *
 *   1. An ENTITY is selected when it, its NEAREST containing type or its
 *      nearest containing module matches an include (none = everything) and
 *      none of the three matches an exclude. Nearest, not transitive: a
 *      sub-package and a nested type are their own nearest containers.
 *   2. A UNIT is asked only if its level is in `levels`.
 *   3. A cycle is one unit. Include and exclude are both existential over its
 *      members — one selected member selects it (as `--scope` always did), one
 *      excluded member bars it — and exclude wins: asking the cycle would ask
 *      the excluded member, and half a cycle is never asked.
 *   4. Closure adds, to the selected units, the LEAST set that makes its
 *      property hold: `dependencies` — every dependency of an asked unit that
 *      may be asked is asked; `containers` — every type and module unit above
 *      an asked unit that may be asked is asked; `all` — both, a fixed point.
 *      "May be asked" is never overridden: closure adds no unit outside
 *      `levels`, none with an excluded member, no trivial member under
 *      `trivial: "skip"`, and walks no dependency edge THROUGH such a unit
 *      (its dependents see it NOT EXPLAINED, so nothing asked would quote what
 *      lies behind it). Containers are reached directly, not stepwise: the
 *      module above an operation is added even when the type between is not.
 *   5. Not asked = `skip-scope`, decided by `planRun`, unchanged.
 *
 * `trivial`: a trivial member (units.ts) is not asked under `"skip"`. A spec
 * that TEMPLATES trivial members takes them out of the filter's reach: they
 * are never `skip-scope`, so they are counted apart and never "added".
 */

export const CLOSURES = ["none", "dependencies", "containers", "all"] as const;
export type Closure = (typeof CLOSURES)[number];

export const TRIVIAL_POLICIES = ["skip", "ask"] as const;
export type TrivialPolicy = (typeof TRIVIAL_POLICIES)[number];

export interface Selection {
  /** Selectors an entity must match (rule 1); several are ANY of them; empty = everything. */
  readonly include: readonly Selector[];
  /** Selectors no entity may match (rule 1); several are ANY of them. Exclude always wins. */
  readonly exclude: readonly Selector[];
  readonly levels: readonly Level[];
  readonly closure: Closure;
  readonly trivial: TrivialPolicy;
}

/** Everything, every level, no closure, trivial members asked: `planRun` with this plans as with no predicate. */
export const UNFILTERED_SELECTION: Selection = Object.freeze({
  include: Object.freeze([]),
  exclude: Object.freeze([]),
  levels: LEVELS,
  closure: "none",
  trivial: "ask",
});

/** What a selection is resolved against — the walk's own graph, units and order. */
export interface SelectionEnv {
  readonly graph: CodeGraph;
  /** The view the selectors are compiled under: the walk's, so an edge term sees the edges the walk sees. */
  readonly view: View;
  readonly units: UnitSet;
  readonly walk: WalkPlan;
  /** Only whether it templates trivial members is read. */
  readonly spec: WalkSpec;
}

/** Why a unit is or is not selected before closure; the first that holds, in this order. */
export const UNIT_STANDINGS = ["outside-levels", "excluded", "trivial", "unselected", "selected"] as const;
export type UnitStanding = (typeof UNIT_STANDINGS)[number];

/** May closure add it? Not when it is outside `levels`, excluded, or a skipped trivial member. */
const BARRED: ReadonlySet<UnitStanding> = new Set(["outside-levels", "excluded", "trivial"]);

export interface ResolvedSelection {
  readonly selection: Selection;
  readonly walk: WalkPlan;
  /** Rule 1 on any entity: it, its nearest type or module matches an include, and none of them an exclude. */
  selects(id: EntityId): boolean;
  /** Rule 1's exclude half: it, its nearest type or its nearest module matches an exclude. */
  excludes(id: EntityId): boolean;
  /** Rules 1–3, levels and `trivial`, before closure. */
  standing(unit: Unit): UnitStanding;
  /** The spec templates it: no call, never `skip-scope`, outside every count of the price. */
  templated(unit: Unit): boolean;
  /** The type and module units above it — its operations' type, the types it is nested in, their modules; never a parent package. */
  containersOf(unit: Unit): readonly string[];
  /** The unit ids walked under a closure mode: the selected ones and what the mode adds (templated units it reaches included). */
  walked(closure: Closure): ReadonlySet<string>;
  /** `PlanOptions.inScope`: walked under the selection's own closure. */
  readonly inScope: (unit: Unit) => boolean;
}

/** One compiled matcher for a list (ANY of it), or none for an empty list. */
function matcherOf(selectors: readonly Selector[], graph: CodeGraph, view: View): SelectorMatcher | undefined {
  if (selectors.length === 0) return undefined;
  return compileSelector(selectors.length === 1 ? (selectors[0] as Selector) : { type: "any", of: selectors }, graph, view);
}

export function resolveSelection(selection: Selection, env: SelectionEnv): ResolvedSelection {
  const { graph, view, units, walk, spec } = env;
  const folder = folderFor(graph);
  const include = matcherOf(selection.include, graph, view);
  const exclude = matcherOf(selection.exclude, graph, view);
  const levels = new Set<Level>(selection.levels);

  // The entity, its nearest type, its nearest module: the three rule 1 asks of a matcher.
  const nearest = (matcher: SelectorMatcher, id: EntityId): boolean => {
    if (matcher.matches(id)) return true;
    const type = folder.containingType(id);
    if (type !== undefined && type !== id && matcher.matches(type)) return true;
    const module = folder.containingModule(id);
    return module !== undefined && module !== id && matcher.matches(module);
  };
  const memo = (test: (id: EntityId) => boolean): ((id: EntityId) => boolean) => {
    const cache = new Map<EntityId, boolean>();
    return (id) => {
      let hit = cache.get(id);
      if (hit === undefined) cache.set(id, (hit = test(id)));
      return hit;
    };
  };
  const excludes = memo((id) => exclude !== undefined && nearest(exclude, id));
  const includes = memo((id) => include === undefined || nearest(include, id));
  const selects = (id: EntityId): boolean => includes(id) && !excludes(id);

  const standings = new Map<string, UnitStanding>();
  const standing = (unit: Unit): UnitStanding => {
    let found = standings.get(unit.id);
    if (found !== undefined) return found;
    if (!levels.has(unit.level)) found = "outside-levels";
    else if (unit.members.some(excludes)) found = "excluded";
    else if (selection.trivial === "skip" && trivialKindOf(unit, units) !== undefined) found = "trivial";
    else found = unit.members.some(includes) ? "selected" : "unselected";
    standings.set(unit.id, found);
    return found;
  };
  const templated = (unit: Unit): boolean => spec.template !== undefined && trivialKindOf(unit, units) !== undefined;
  const containersOf = containersIndex(graph, units, walk);

  const closures = new Map<Closure, ReadonlySet<string>>();
  const walked = (closure: Closure): ReadonlySet<string> => {
    let set = closures.get(closure);
    if (set === undefined) closures.set(closure, (set = closeOver(walk, standing, containersOf, closure)));
    return set;
  };
  const own = walked(selection.closure);
  return {
    selection,
    walk,
    selects,
    excludes,
    standing,
    templated,
    containersOf,
    walked,
    inScope: (unit) => own.has(unit.id),
  };
}

/**
 * The least superset of the selected units closed under the mode: a breadth
 * walk from them along dependencies and/or up to containers, adding (and
 * walking on from) only units that may be asked.
 */
function closeOver(
  walk: WalkPlan,
  standing: (unit: Unit) => UnitStanding,
  containersOf: (unit: Unit) => readonly string[],
  closure: Closure,
): ReadonlySet<string> {
  const set = new Set<string>();
  const queue: Unit[] = [];
  for (const unit of walk.units) {
    if (standing(unit) !== "selected") continue;
    set.add(unit.id);
    queue.push(unit);
  }
  const dependencies = closure === "dependencies" || closure === "all";
  const containers = closure === "containers" || closure === "all";
  if (!dependencies && !containers) return set;
  for (let at = 0; at < queue.length; at += 1) {
    const next = queue[at] as Unit;
    const reached = [...(dependencies ? next.deps : []), ...(containers ? containersOf(next) : [])];
    for (const id of reached) {
      if (set.has(id)) continue;
      const unit = walk.unitOf.get(id);
      if (unit === undefined || BARRED.has(standing(unit))) continue;
      set.add(id);
      queue.push(unit);
    }
  }
  return set;
}

/**
 * Containment as the walk orders by it (order.ts): a type above its
 * operations and the types nested in it, a module above every type it holds.
 * A parent PACKAGE is above nothing — module containment is a namespace, not
 * a dependency. Transitive, so a nested type's operation reaches the outer
 * type and the module directly; a unit's own id is never its container.
 */
function containersIndex(graph: CodeGraph, units: UnitSet, walk: WalkPlan): (unit: Unit) => readonly string[] {
  const above = new Map<EntityId, EntityId[]>();
  const link = (child: EntityId, parent: EntityId): void => {
    const bucket = above.get(child);
    if (bucket === undefined) above.set(child, [parent]);
    else bucket.push(parent);
  };
  for (const op of units.operations.values()) link(op.id, op.typeId);
  for (const typeId of units.types.keys()) {
    for (const child of graph.childrenOf(typeId)) if (units.types.has(child)) link(child, typeId);
  }
  for (const module of units.modules.values()) for (const typeId of module.types) if (units.types.has(typeId)) link(typeId, module.id);

  const cache = new Map<string, readonly string[]>();
  return (unit) => {
    const cached = cache.get(unit.id);
    if (cached !== undefined) return cached;
    const seen = new Set<EntityId>(unit.members);
    const stack = unit.members.flatMap((member) => above.get(member) ?? []);
    const found = new Set<string>();
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const container = walk.unitOf.get(id);
      if (container !== undefined && container.id !== unit.id) found.add(container.id);
      stack.push(...(above.get(id) ?? []));
    }
    const result = [...found].sort();
    cache.set(unit.id, result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// The price of the alternative
// ---------------------------------------------------------------------------

export type LevelCounts = Readonly<Record<Level, number>>;

/**
 * What a caller prints about a selection — "N dependencies of the selection
 * are not walked; `--closure dependencies` adds M units" — as counts by
 * level, on a COLD plan (a warm store reuses some of these units instead).
 * Templated units are outside every count but `templated`.
 */
export interface SelectionPrice {
  /** The selection's own closure. */
  readonly closure: Closure;
  /** Selected before closure: rules 1–3, levels, `trivial`. */
  readonly selected: LevelCounts;
  /** What each closure mode adds to `selected` — a cold plan's `skip-scope` count falls by exactly this. */
  readonly added: Readonly<Record<Closure, LevelCounts>>;
  /** Under the selection's own closure: what is asked (`selected` + `added[closure]`) and what is left `skip-scope`. */
  readonly asked: LevelCounts;
  readonly leftOut: LevelCounts;
  /**
   * The units an asked unit depends on DIRECTLY that are not asked — its prompt
   * shows them NOT EXPLAINED — each counted once, by its standing.
   * `unselected` is what `dependencies` closure would reach first.
   */
  readonly notWalked: {
    readonly unselected: LevelCounts;
    readonly excluded: LevelCounts;
    readonly outsideLevels: LevelCounts;
    readonly trivial: LevelCounts;
  };
  readonly templated: LevelCounts;
}

const zero = (): Record<Level, number> => ({ operation: 0, type: 0, module: 0 });

export function priceSelection(resolved: ResolvedSelection): SelectionPrice {
  const { walk } = resolved;
  const filtered = walk.units.filter((unit) => !resolved.templated(unit));
  const count = (keep: (unit: Unit) => boolean): LevelCounts => {
    const counts = zero();
    for (const unit of filtered) if (keep(unit)) counts[unit.level] += 1;
    return counts;
  };
  const none = resolved.walked("none");
  const own = resolved.walked(resolved.selection.closure);
  const added = Object.fromEntries(
    CLOSURES.map((closure) => {
      const set = resolved.walked(closure);
      return [closure, count((unit) => set.has(unit.id) && !none.has(unit.id))];
    }),
  ) as Record<Closure, LevelCounts>;

  const shownMissing = new Set<string>();
  for (const unit of filtered) {
    if (!own.has(unit.id)) continue;
    for (const dep of unit.deps) {
      const target = walk.unitOf.get(dep);
      if (target !== undefined && !own.has(dep) && !resolved.templated(target)) shownMissing.add(dep);
    }
  }
  const missing = (standing: UnitStanding): LevelCounts => count((unit) => shownMissing.has(unit.id) && resolved.standing(unit) === standing);

  return {
    closure: resolved.selection.closure,
    selected: count((unit) => none.has(unit.id)),
    added,
    asked: count((unit) => own.has(unit.id)),
    leftOut: count((unit) => !own.has(unit.id)),
    notWalked: {
      unselected: missing("unselected"),
      excluded: missing("excluded"),
      outsideLevels: missing("outside-levels"),
      trivial: missing("trivial"),
    },
    templated: templatedCounts(walk, resolved),
  };
}

function templatedCounts(walk: WalkPlan, resolved: ResolvedSelection): LevelCounts {
  const counts = zero();
  for (const unit of walk.units) if (resolved.templated(unit)) counts[unit.level] += 1;
  return counts;
}
