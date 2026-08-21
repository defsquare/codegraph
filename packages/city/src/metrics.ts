import type { Entity, EntityId } from "@codegraph/core";
import type { CodeGraph, CouplingRow, FoldedNode } from "@codegraph/analyzer";

/**
 * WHAT A BUILDING IS MEASURED BY.
 *
 * The city's dimensions are configurable because there is no single right
 * answer: lines of code says "how much is written here", member count says "how
 * much is declared here", fan-in says "how much depends on this". Each is a
 * different claim, so each is a named source the caller picks, and the picked
 * name travels into the artefact (`CityModel.bindings`) — a building height
 * whose metric is not stated is not a fact.
 *
 * A SOURCE MAY SAY "I DO NOT KNOW". `value` returns `undefined` when the model
 * carries no answer — a type with no anchor has no line count, and nothing may
 * turn that into a zero. `buildCity` records the misses in its diagnostics and
 * floors those buildings at the channel's minimum, so a reader can tell
 * "smallest" from "unmeasured".
 *
 * CYCLOMATIC COMPLEXITY, AND ANYTHING ELSE AN EXTRACTOR MEASURES. No extractor
 * emits complexity today, and this package will not invent it by re-parsing
 * source it cannot see. The hook is the metamodel's own: an entity is a LOOSE
 * object (METAMODEL.md §2), so an extractor may carry `cyclomatic: 12` on a
 * method and it survives loading untouched. Two open-ended sources read those
 * keys:
 *
 *   `attribute:cyclomatic`  the building's OWN numeric key
 *   `sum:cyclomatic`        the same key summed over everything that folded
 *                           into the building — the form complexity wants,
 *                           since complexity is measured per method
 *
 * So `--height sum:cyclomatic` works the day an extractor emits the key, with
 * no change here, and reports "unmeasured" honestly until then.
 */

/** Everything a source may read about one building. Nothing here is mutable. */
export interface MetricContext {
  readonly graph: CodeGraph;
  /** The folded type node this building renders. */
  readonly node: FoldedNode;
  /** The type entity itself; absent when an edge referenced an id nothing declares. */
  readonly entity: Entity | undefined;
  /**
   * Every base entity that folded into this building, the type included, in the
   * graph's own id order — the type's methods, fields, parameters and locals.
   */
  readonly members: readonly Entity[];
  /** Type-level coupling row; absent when the type has no edges at all. */
  readonly coupling: CouplingRow | undefined;
}

export interface MetricSource {
  /** The name the caller types, e.g. `loc` or `sum:cyclomatic`. */
  readonly name: string;
  /** What one unit of the value is, for the legend: `source lines`, `methods`… */
  readonly unit: string;
  readonly describe: string;
  /** `undefined` means the model does not say — never 0. */
  value(context: MetricContext): number | undefined;
}

/** Anchors are `[startLine, endLine]`, 1-based and inclusive (core's SourceAnchor). */
function anchorLines(entity: Entity | undefined): number | undefined {
  const anchor = (entity as { anchor?: { span?: [number, number] } } | undefined)?.anchor;
  if (anchor?.span === undefined) return undefined;
  const [start, end] = anchor.span;
  return end - start + 1;
}

/** A loose numeric key, or `undefined` — a non-number is not a measurement. */
function numericKey(entity: Entity | undefined, key: string): number | undefined {
  const value = (entity as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countMembers(context: MetricContext, predicate: (entity: Entity) => boolean): number {
  let count = 0;
  for (const member of context.members) if (predicate(member)) count += 1;
  return count;
}

function hasTraitName(entity: Entity, trait: string): boolean {
  return entity.traits.includes(trait as Entity["traits"][number]);
}

const BUILT_IN: readonly MetricSource[] = [
  {
    name: "loc",
    unit: "source lines",
    describe: "Lines the type's own source anchor spans (end - start + 1).",
    value: (context) => anchorLines(context.entity),
  },
  {
    name: "members",
    unit: "entities",
    describe: "Base entities that folded into the building, the type included.",
    value: (context) => context.node.members,
  },
  {
    name: "methods",
    unit: "methods",
    describe: "Members carrying TInvocable — methods, constructors and lambdas.",
    value: (context) => countMembers(context, (member) => hasTraitName(member, "TInvocable")),
  },
  {
    name: "fields",
    unit: "fields",
    describe: "Members carrying TStructural whose container is the type itself.",
    value: (context) =>
      countMembers(
        context,
        (member) =>
          hasTraitName(member, "TStructural") &&
          (member as { parent?: EntityId }).parent === context.node.id,
      ),
  },
  {
    name: "fanIn",
    unit: "dependents",
    describe: "Distinct types that depend on this one, at type level, under the view.",
    value: (context) => context.coupling?.fanIn ?? 0,
  },
  {
    name: "fanOut",
    unit: "dependencies",
    describe: "Distinct types this one depends on, at type level, under the view.",
    value: (context) => context.coupling?.fanOut ?? 0,
  },
  {
    name: "degree",
    unit: "relations",
    describe: "fanIn + fanOut — how connected the type is, in either direction.",
    value: (context) => (context.coupling?.fanIn ?? 0) + (context.coupling?.fanOut ?? 0),
  },
  {
    name: "one",
    unit: "buildings",
    describe: "The constant 1 — a uniform city, for isolating one channel at a time.",
    value: () => 1,
  },
];

export const METRIC_SOURCES: ReadonlyMap<string, MetricSource> = new Map(
  BUILT_IN.map((source) => [source.name, source] as const),
);

/** The open-ended forms, documented once so the help text cannot drift. */
export const METRIC_PREFIXES: readonly { readonly prefix: string; readonly describe: string }[] = [
  {
    prefix: "attribute:",
    describe: "A numeric key the extractor put on the type itself, e.g. attribute:cyclomatic.",
  },
  {
    prefix: "sum:",
    describe:
      "A numeric key summed over everything that folded into the building, e.g. sum:cyclomatic.",
  },
];

export class UnknownMetricError extends Error {
  constructor(readonly metric: string) {
    super(
      `unknown metric source: ${metric}. Known sources: ${[...METRIC_SOURCES.keys()].join(", ")}` +
        `; or ${METRIC_PREFIXES.map((form) => `${form.prefix}<key>`).join(" / ")}.`,
    );
    this.name = "UnknownMetricError";
  }
}

function attributeSource(key: string): MetricSource {
  return {
    name: `attribute:${key}`,
    unit: key,
    describe: `The type's own numeric \`${key}\` key, when the extractor emitted one.`,
    value: (context) => numericKey(context.entity, key),
  };
}

/**
 * Summed over members. Returns `undefined` — not 0 — when NO member carries the
 * key: "nothing measured this" and "everything measured zero" are different
 * statements, and only the second is a fact about the code.
 */
function sumSource(key: string): MetricSource {
  return {
    name: `sum:${key}`,
    unit: key,
    describe: `\`${key}\` summed over every member of the type, when the extractor emitted it.`,
    value: (context) => {
      let total: number | undefined;
      for (const member of context.members) {
        const value = numericKey(member, key);
        if (value === undefined) continue;
        total = (total ?? 0) + value;
      }
      return total;
    },
  };
}

/**
 * A name (or a source object, for a caller with its own measurement) resolved
 * to the source that will be asked. Throws on an unknown name rather than
 * defaulting: a silent fallback would put a documented metric's name on a
 * different metric's numbers.
 */
export function resolveMetric(metric: string | MetricSource): MetricSource {
  if (typeof metric !== "string") return metric;
  const built = METRIC_SOURCES.get(metric);
  if (built !== undefined) return built;
  for (const { prefix } of METRIC_PREFIXES) {
    if (!metric.startsWith(prefix)) continue;
    const key = metric.slice(prefix.length);
    if (key.length === 0) throw new UnknownMetricError(metric);
    return prefix === "attribute:" ? attributeSource(key) : sumSource(key);
  }
  throw new UnknownMetricError(metric);
}

/** The built-in names, sorted — for help text generated from the registry. */
export function metricNames(): readonly string[] {
  return [...METRIC_SOURCES.keys()].sort();
}
