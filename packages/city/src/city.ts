import { parseRenderedId } from "@codegraph/core";
import type { EdgeKind, Entity, EntityId, Provenance } from "@codegraph/core";
import {
  coupling,
  createFolder,
  foldGraph,
  identityView,
  sortIds,
  type CodeGraph,
  type CouplingRow,
  type FoldedEdge,
  type FoldedNode,
  type View,
  type ViewDescriptor,
} from "@codegraph/analyzer";
import {
  isAttributeOf,
  isOperation,
  resolveMetric,
  type MetricContext,
  type MetricSource,
} from "./metrics.js";
import { resolveScale, round, scaleValue, type Domain, type Range, type ScaleName } from "./scale.js";

/**
 * THE CITY MODEL: a second model, derived from the first.
 *
 * The mapping, and it is the whole vocabulary:
 *
 *   module (TModule)   ->  DISTRICT   the landscape a building stands on
 *   type   (TType)     ->  BUILDING   dimensions from configurable metrics
 *   type dependency    ->  ARROW      drawn roof to roof, weighted by count
 *
 * WHAT THIS TRANSFORM DOES NOT DO — deliberately: placement. No building has a
 * position and no district has bounds; a district carries the total base area
 * its buildings demand, which is the input the layout pass (`layoutCity`,
 * layout.ts) consumes. Publishing a model with no coordinates is what keeps
 * that pass replaceable: nothing here has to be undone to lay the city out
 * differently.
 *
 * HONESTY RULES IT INHERITS (CLAUDE.md, "meaning controls appearance"):
 *  - Every dimension names the metric and the scale that produced it, in
 *    `bindings`. A height with no stated metric is decoration.
 *  - A metric the model cannot supply is `null` on the building and counted in
 *    `diagnostics.unmeasured` — floored to the channel minimum, never zeroed,
 *    so "smallest" and "unmeasured" stay distinguishable.
 *  - `inferred` on an arrow is true when any folded base edge is not
 *    `declared`; the renderer must keep those visually distinct from facts.
 *  - Containment comes from the model's own `parent` chain (the analyzer's
 *    fold), never from splitting a name or an id (CLAUDE.md invariant 7). That
 *    is also why districts are FLAT: the Java extractor's packages carry no
 *    parent package, so a `com.acme.order` / `com.acme.order.legacy` nesting
 *    would be an inference from a name, not a fact from the model.
 */

export const CITY_ARTEFACT_KIND = "codegraph.city/1";
export const CITY_GENERATOR = "@codegraph/city";

/** The visual channels this transform binds. Position is not one of them yet. */
export const CHANNELS = ["height", "footprint"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** What the renderer may assume about the model it is handed. */
export interface CityConventions {
  /** Arrows attach at the roof of each building, at both ends. */
  readonly arrowAttachment: "roof";
  /** `height` grows along this axis; the footprint lies in the other two. */
  readonly heightAxis: "y";
  /** Ground plane the districts tile. */
  readonly groundPlane: "xz";
  /**
   * Dimensions are in abstract city units — a position within the metric's
   * range, not metres and not pixels. Only the ratios between buildings mean
   * anything.
   */
  readonly units: "city";
}

const CONVENTIONS: CityConventions = {
  arrowAttachment: "roof",
  heightAxis: "y",
  groundPlane: "xz",
  units: "city",
};

/** One channel as the caller configured it. */
export interface ChannelBinding {
  /** A built-in name (`loc`), an open form (`sum:cyclomatic`), or a custom source. */
  readonly metric?: string | MetricSource;
  readonly scale?: ScaleName | string;
  /** Dimension given to the smallest measured value. */
  readonly min?: number;
  /** Dimension given to the largest measured value. */
  readonly max?: number;
}

/** The same channel as it was actually applied — this is what ships in the artefact. */
export interface ResolvedBinding {
  readonly channel: ChannelName;
  readonly metric: string;
  readonly unit: string;
  readonly describe: string;
  readonly scale: ScaleName;
  readonly range: Range;
  /** Observed across the buildings that had a value; absent when none did. */
  readonly domain: Domain | undefined;
  /** Buildings the model could not measure on this channel. */
  readonly unmeasured: number;
}

/**
 * The natural key's components, emitted for DISPLAY only — decoded by core's
 * own `parseRenderedId` (the verified inverse of `renderId`), never used to
 * decide membership, containment or equality. Absent when the id is not a
 * rendered id (a hand-built model may carry any string).
 */
export interface IdentityComponents {
  readonly lang: string;
  readonly module: string;
  /** Empty exactly when the element IS the module (a district). */
  readonly symbol: string;
  readonly disambiguator?: string;
}

/** One field of a type, for the detail panel: its name and, when the model
 * resolves it, the NAME of its declared type — never a raw id. */
export interface BuildingAttribute {
  readonly name: string;
  readonly type?: string;
}

/** One declared parameter of an operation; `type` is the resolved entity's
 * name, absent when the model cannot resolve it (same rule as attributes). */
export interface BuildingParameter {
  readonly name: string;
  readonly type?: string;
}

/** One invocable of a type — methods, constructors and lambdas alike carry a
 * signature; a name alone stands in when the model gives none. */
export interface BuildingOperation {
  readonly signature: string;
  /** In declaration order; absent when the model declares no parameter list. */
  readonly parameters?: readonly BuildingParameter[];
}

export interface Building {
  readonly id: EntityId;
  readonly name: string | undefined;
  /** The entity kind, verbatim from the model: `class`, `interface`, `enum`… */
  readonly kind: string;
  readonly isStub: boolean;
  readonly district: EntityId;
  readonly identity?: IdentityComponents;
  /** Along the height axis. */
  readonly height: number;
  /** Base rectangle; square today, a layout concern the day it is not. */
  readonly footprint: { readonly width: number; readonly depth: number };
  /**
   * Raw measurements, by metric name — the bound channels plus anything the
   * caller asked to carry. `null` means the model does not say.
   */
  readonly metrics: Readonly<Record<string, number | null>>;
  /** Sorted by name; empty for stubs and memberless types, never absent. */
  readonly attributes: readonly BuildingAttribute[];
  /** Sorted by signature; empty for stubs and memberless types, never absent. */
  readonly operations: readonly BuildingOperation[];
}

export interface District {
  readonly id: EntityId;
  readonly name: string | undefined;
  readonly kind: string;
  readonly isStub: boolean;
  readonly identity?: IdentityComponents;
  /**
   * The nearest ancestor module that is itself a district of this city, when
   * the MODEL declares module containment (`TChildOf` on the module — e.g. the
   * Java extractor emits package nesting walked on Spoon's structure). Absent
   * for a root district and for models without module containment; never
   * derived from the id or the name.
   */
  readonly parent?: EntityId;
  /** Sorted; every building whose type folds into this module. */
  readonly buildings: readonly EntityId[];
  /**
   * Total base area its buildings occupy, in city units². The layout pass's
   * input: a district must be at least this big before packing and padding.
   */
  readonly footprintDemand: number;
}

export interface Arrow {
  readonly from: EntityId;
  readonly to: EntityId;
  /** Base edges aggregated into this arrow. */
  readonly count: number;
  /** Sorted. */
  readonly kinds: readonly EdgeKind[];
  /** Sorted. */
  readonly provenances: readonly Provenance[];
  /** True when at least one base edge is not `declared` — an inference, not a fact. */
  readonly inferred: boolean;
  /** True when the endpoints stand in different districts. */
  readonly crossDistrict: boolean;
}

export interface CityDiagnostics {
  /** Types whose module the model does not give; excluded from the city, sorted. */
  readonly unplacedBuildings: readonly EntityId[];
  /** Arrows dropped because an endpoint was not placed. */
  readonly droppedArrows: number;
  /** Type-level self-dependencies, excluded: a roof-to-roof arrow to itself draws nothing. */
  readonly selfArrows: number;
  /** District arrows dropped because an endpoint module is not a district here. */
  readonly droppedDistrictArrows: number;
  /** Module-level self-dependencies, excluded — internal cohesion, not an arrow. */
  readonly selfDistrictArrows: number;
  /** Per metric name, how many buildings the model could not measure. */
  readonly unmeasured: Readonly<Record<string, number>>;
  /** Passed through from the fold that produced the buildings. */
  readonly fold: {
    readonly unfoldableEntities: number;
    readonly droppedEdges: number;
    readonly foldedEdges: number;
  };
}

export interface CityModel {
  /** Always `codegraph.city/1` — a derived model, never an interchange model.jsonl. */
  readonly kind: string;
  readonly generatedBy: string;
  /** The view the city was built under; a city without its view is not a fact. */
  readonly view: ViewDescriptor;
  /**
   * What corpus this city renders: a display name (the deduped, sorted root
   * basenames joined with " + ", or the caller's `name`) and the model roots
   * verbatim. The renderer's header shows `name`; it decides nothing.
   */
  readonly corpus: { readonly name: string; readonly roots: readonly string[] };
  readonly conventions: CityConventions;
  readonly bindings: readonly ResolvedBinding[];
  /** Sorted by id. */
  readonly districts: readonly District[];
  /** Sorted by id. */
  readonly buildings: readonly Building[];
  /** Sorted by (from, to). */
  readonly arrows: readonly Arrow[];
  /**
   * Module-level dependencies between districts, from the analyzer's fold at
   * `level: "module"` under the same view — the fan-in/fan-out a landscape
   * renders. Kept beside the type arrows so no renderer has to re-derive
   * module facts by aggregating (it would get stub and view rules wrong).
   * `crossDistrict` is trivially true here.
   */
  readonly districtArrows: readonly Arrow[];
  readonly diagnostics: CityDiagnostics;
}

export interface CityOptions {
  readonly view?: View;
  /** Display name for the corpus; defaults to the model roots' basenames. */
  readonly name?: string;
  /** Defaults to `loc` on a linear scale. */
  readonly height?: ChannelBinding;
  /** Defaults to `members` on a sqrt scale, so base AREA grows with the metric. */
  readonly footprint?: ChannelBinding;
  /** Extra metrics to measure and carry on every building, unbound to any channel. */
  readonly carry?: readonly (string | MetricSource)[];
  /** Restrict the arrows to these base edge kinds; defaults to all of them. */
  readonly edgeKinds?: readonly EdgeKind[];
}

interface ChannelDefault {
  readonly metric: string;
  readonly scale: ScaleName;
  readonly min: number;
  readonly max: number;
}

const DEFAULTS: Readonly<Record<ChannelName, ChannelDefault>> = {
  // Height reads as "how much code stands here", so it is linear in lines: a
  // tower twice as tall holds twice the source.
  height: { metric: "loc", scale: "linear", min: 1, max: 40 },
  // The footprint metric maps to the SIDE through sqrt, which makes the base
  // AREA proportional to the metric — the reading a city plan invites.
  footprint: { metric: "members", scale: "sqrt", min: 2, max: 20 },
};

interface Measured {
  readonly node: FoldedNode;
  readonly district: EntityId;
  readonly values: Map<string, number | undefined>;
}

/**
 * Build the city. Pure: the graph is read, nothing is written back.
 *
 * The order of business matters and is not negotiable — a dimension cannot be
 * assigned before the domain it is relative to is known:
 *   1. fold to type level (buildings) and place each in its module (district),
 *   2. measure every building with every metric,
 *   3. only then map measurements onto dimensions, per channel domain.
 */
export function buildCity(graph: CodeGraph, options: CityOptions = {}): CityModel {
  const view = options.view ?? identityView;
  const folded = foldGraph(graph, {
    level: "type",
    view,
    ...(options.edgeKinds === undefined ? {} : { edgeKinds: options.edgeKinds }),
  });
  const folder = createFolder(graph);
  const couplingRows = new Map<EntityId, CouplingRow>(
    coupling(folded).rows.map((row) => [row.id, row] as const),
  );

  const bindings = resolveBindings(options);
  const carried = (options.carry ?? []).map(resolveMetric);
  // One source per name: binding a metric AND carrying it must not measure twice.
  const sources = new Map<string, MetricSource>();
  for (const source of [...bindings.map((binding) => binding.source), ...carried]) {
    sources.set(source.name, source);
  }

  const membersByType = groupMembers(graph, folder);

  // Step 1 — place the buildings. A type whose module the model does not give
  // is EXCLUDED rather than dropped into a synthetic district: inventing a
  // "(none)" district would put buildings on ground the model never described.
  const measured: Measured[] = [];
  const unplaced: EntityId[] = [];
  for (const node of folded.nodes) {
    const district = folder.containingModule(node.id);
    if (district === undefined) {
      unplaced.push(node.id);
      continue;
    }
    const context: MetricContext = {
      graph,
      node,
      entity: graph.entity(node.id),
      members: membersByType.get(node.id) ?? [],
      coupling: couplingRows.get(node.id),
    };
    // Step 2 — measure, before any dimension exists.
    const values = new Map<string, number | undefined>();
    for (const [name, source] of sources) values.set(name, source.value(context));
    measured.push({ node, district, values });
  }

  // Step 3 — dimensions, each relative to its channel's observed domain.
  const unmeasured: Record<string, number> = {};
  for (const name of sources.keys()) unmeasured[name] = 0;
  for (const building of measured) {
    for (const [name, value] of building.values) {
      if (value === undefined) unmeasured[name] = (unmeasured[name] ?? 0) + 1;
    }
  }
  const domains = new Map<ChannelName, Domain | undefined>();
  for (const binding of bindings) {
    domains.set(binding.channel, domainOf(measured, binding.source.name));
  }

  const buildings: Building[] = measured.map((building) => {
    const dimension = (channel: ChannelName): number => {
      const binding = bindings.find((candidate) => candidate.channel === channel);
      if (binding === undefined) throw new Error(`no binding for channel ${channel}`);
      const value = building.values.get(binding.source.name);
      const domain = domains.get(channel);
      // Unmeasured floors at the channel minimum — and says so in diagnostics.
      if (value === undefined || domain === undefined) return round(binding.range.min);
      return round(scaleValue(value, domain, binding.range, binding.scale));
    };
    const side = dimension("footprint");
    const metrics: Record<string, number | null> = {};
    for (const name of [...building.values.keys()].sort()) {
      metrics[name] = building.values.get(name) ?? null;
    }
    const members = membersByType.get(building.node.id) ?? [];
    const identity = identityOf(building.node.id);
    return {
      id: building.node.id,
      name: building.node.name,
      kind: building.node.kind,
      isStub: building.node.isStub,
      district: building.district,
      ...(identity === undefined ? {} : { identity }),
      height: dimension("height"),
      footprint: { width: side, depth: side },
      metrics,
      attributes: attributesOf(graph, building.node.id, members),
      operations: operationsOf(graph, members),
    };
  });

  const byId = new Map(buildings.map((building) => [building.id, building] as const));
  const districts = collectDistricts(graph, folder, buildings);

  // Arrows: type-level dependencies, roof to roof. A self-dependency is a
  // method calling a sibling of its own class — real, and not an arrow.
  const arrows: Arrow[] = [];
  let selfArrows = 0;
  let droppedArrows = 0;
  for (const edge of folded.edges) {
    if (edge.selfLoop || edge.from === edge.to) {
      selfArrows += 1;
      continue;
    }
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) {
      droppedArrows += 1;
      continue;
    }
    arrows.push(arrowFor(edge, from, to));
  }

  // District arrows: the SAME graph folded at module level, so module facts
  // (stub folding, view filtering, import edges) come from the analyzer, not
  // from re-aggregating type arrows here.
  const moduleFolded = foldGraph(graph, {
    level: "module",
    view,
    ...(options.edgeKinds === undefined ? {} : { edgeKinds: options.edgeKinds }),
  });
  const districtIds = new Set(districts.map((district) => district.id));
  const districtArrows: Arrow[] = [];
  let selfDistrictArrows = 0;
  let droppedDistrictArrows = 0;
  for (const edge of moduleFolded.edges) {
    if (edge.selfLoop || edge.from === edge.to) {
      selfDistrictArrows += 1;
      continue;
    }
    if (!districtIds.has(edge.from) || !districtIds.has(edge.to)) {
      droppedDistrictArrows += 1;
      continue;
    }
    const provenances = [...edge.provenances].sort();
    districtArrows.push({
      from: edge.from,
      to: edge.to,
      count: edge.count,
      kinds: [...edge.kinds].sort(),
      provenances,
      inferred: provenances.some((provenance) => provenance !== "declared"),
      crossDistrict: true,
    });
  }

  return {
    kind: CITY_ARTEFACT_KIND,
    generatedBy: CITY_GENERATOR,
    view: folded.view,
    corpus: corpusOf(graph, options.name),
    conventions: CONVENTIONS,
    bindings: bindings.map((binding) => ({
      channel: binding.channel,
      metric: binding.source.name,
      unit: binding.source.unit,
      describe: binding.source.describe,
      scale: binding.scale,
      range: binding.range,
      domain: domains.get(binding.channel),
      unmeasured: unmeasured[binding.source.name] ?? 0,
    })),
    districts,
    buildings,
    arrows,
    districtArrows,
    diagnostics: {
      unplacedBuildings: sortIds(unplaced),
      droppedArrows,
      selfArrows,
      droppedDistrictArrows,
      selfDistrictArrows,
      unmeasured,
      fold: {
        unfoldableEntities: folded.diagnostics.unfoldableEntities.length,
        droppedEdges: folded.diagnostics.droppedEdges,
        foldedEdges: folded.diagnostics.foldedEdges,
      },
    },
  };
}

interface ResolvedChannel {
  readonly channel: ChannelName;
  readonly source: MetricSource;
  readonly scale: ScaleName;
  readonly range: Range;
}

function resolveBindings(options: CityOptions): readonly ResolvedChannel[] {
  return CHANNELS.map((channel) => {
    const defaults = DEFAULTS[channel];
    const given: ChannelBinding = options[channel] ?? {};
    const range: Range = { min: given.min ?? defaults.min, max: given.max ?? defaults.max };
    if (!(range.max >= range.min)) {
      throw new Error(`${channel}: max (${range.max}) is below min (${range.min})`);
    }
    return {
      channel,
      source: resolveMetric(given.metric ?? defaults.metric),
      scale: resolveScale(given.scale ?? defaults.scale),
      range,
    };
  });
}

function domainOf(measured: readonly Measured[], metric: string): Domain | undefined {
  let min: number | undefined;
  let max: number | undefined;
  for (const building of measured) {
    const value = building.values.get(metric);
    if (value === undefined) continue;
    min = min === undefined ? value : Math.min(min, value);
    max = max === undefined ? value : Math.max(max, value);
  }
  return min === undefined || max === undefined ? undefined : { min, max };
}

/**
 * The corpus line of the artefact. The display name is the deduped, sorted
 * basenames of the model roots (or the caller's override) — a label for a
 * header, deciding nothing. Roots are reported verbatim, blanks excluded.
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

/**
 * Display components of a rendered id — core's own decoding, tolerant: an id
 * core did not render (hand-built models may carry any string) yields nothing,
 * and the element simply ships without `identity`.
 */
function identityOf(id: EntityId): Building["identity"] {
  try {
    const key = parseRenderedId(id);
    return {
      lang: key.lang,
      module: key.module,
      symbol: key.symbol,
      ...(key.disambiguator === undefined ? {} : { disambiguator: key.disambiguator }),
    };
  } catch {
    return undefined;
  }
}

/** Code-unit compare, the workspace's one string order (same as `sortIds`). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function attributesOf(
  graph: CodeGraph,
  type: EntityId,
  members: readonly Entity[],
): readonly BuildingAttribute[] {
  const isAttribute = isAttributeOf(type);
  return members
    .filter(isAttribute)
    .map((member) => {
      const name = (member as { name?: string }).name ?? member.id;
      const declared = (member as { declaredType?: EntityId }).declaredType;
      // The type is the NAME of the resolved entity — an unresolvable
      // declaredType stays absent rather than leaking as an id string.
      const typeName =
        declared === undefined
          ? undefined
          : (graph.entity(declared) as { name?: string } | undefined)?.name;
      return { name, ...(typeName === undefined ? {} : { type: typeName }) };
    })
    .sort((a, b) => compareStrings(a.name, b.name));
}

function operationsOf(graph: CodeGraph, members: readonly Entity[]): readonly BuildingOperation[] {
  return members
    .filter(isOperation)
    .map((member) => {
      const signature =
        (member as { signature?: string }).signature ??
        (member as { name?: string }).name ??
        member.id;
      const declared = (member as { parameters?: readonly EntityId[] }).parameters;
      if (declared === undefined) return { signature };
      // Declaration order, never re-sorted — position IS the parameter's
      // meaning. An unresolvable parameter id is skipped, an unresolvable
      // declaredType drops just the type key (the attributesOf rule).
      const parameters = declared.flatMap((id) => {
        const parameter = graph.entity(id) as { name?: string; declaredType?: EntityId } | undefined;
        if (parameter?.name === undefined) return [];
        const typeName =
          parameter.declaredType === undefined
            ? undefined
            : (graph.entity(parameter.declaredType) as { name?: string } | undefined)?.name;
        return [{ name: parameter.name, ...(typeName === undefined ? {} : { type: typeName }) }];
      });
      return { signature, parameters };
    })
    .sort((a, b) => compareStrings(a.signature, b.signature));
}

/**
 * Every entity grouped under the type it folds into — one pass over the graph
 * rather than a walk per building, which would be quadratic on a real corpus.
 */
function groupMembers(
  graph: CodeGraph,
  folder: ReturnType<typeof createFolder>,
): ReadonlyMap<EntityId, readonly Entity[]> {
  const members = new Map<EntityId, Entity[]>();
  for (const id of graph.ids()) {
    const type = folder.containingType(id);
    if (type === undefined) continue;
    const entity = graph.entity(id);
    if (entity === undefined) continue;
    const bucket = members.get(type);
    if (bucket === undefined) members.set(type, [entity]);
    else bucket.push(entity);
  }
  return members;
}

/**
 * Districts are exactly the modules the placed buildings stand in. A module
 * with no building in this view gets no district: empty ground nobody stands on
 * is not part of the city, and drawing it would claim a module the view excluded.
 */
function collectDistricts(
  graph: CodeGraph,
  folder: ReturnType<typeof createFolder>,
  buildings: readonly Building[],
): readonly District[] {
  const grouped = new Map<EntityId, Building[]>();
  for (const building of buildings) {
    const bucket = grouped.get(building.district);
    if (bucket === undefined) grouped.set(building.district, [building]);
    else bucket.push(building);
  }

  const districtIds = new Set(grouped.keys());
  return sortIds([...grouped.keys()]).map((id) => {
    const entity = graph.entity(id);
    const members = grouped.get(id) ?? [];
    const demand = members.reduce(
      (total, building) => total + building.footprint.width * building.footprint.depth,
      0,
    );
    const parent = parentDistrictOf(graph, folder, id, districtIds);
    const identity = identityOf(id);
    return {
      id,
      name: (entity as { name?: string } | undefined)?.name,
      kind: entity?.kind ?? "module",
      isStub: graph.isStub(id),
      ...(identity === undefined ? {} : { identity }),
      ...(parent === undefined ? {} : { parent }),
      buildings: sortIds(members.map((building) => building.id)),
      footprintDemand: round(demand),
    };
  });
}

/**
 * Nearest ancestor module — via the MODEL's declared containment, never the
 * id — that is itself a district of this city. Ancestors the view excluded
 * (no buildings) are skipped, so nesting never invents an empty plot.
 */
function parentDistrictOf(
  graph: CodeGraph,
  folder: ReturnType<typeof createFolder>,
  id: EntityId,
  districtIds: ReadonlySet<EntityId>,
): EntityId | undefined {
  const seen = new Set<EntityId>([id]);
  let cursor = (graph.entity(id) as { parent?: EntityId } | undefined)?.parent;
  while (cursor !== undefined) {
    const module = folder.containingModule(cursor);
    if (module === undefined || seen.has(module)) return undefined; // dead end or cycle
    if (districtIds.has(module)) return module;
    seen.add(module);
    cursor = (graph.entity(module) as { parent?: EntityId } | undefined)?.parent;
  }
  return undefined;
}

function arrowFor(edge: FoldedEdge, from: Building, to: Building): Arrow {
  const provenances = [...edge.provenances].sort();
  return {
    from: edge.from,
    to: edge.to,
    count: edge.count,
    kinds: [...edge.kinds].sort(),
    provenances,
    inferred: provenances.some((provenance) => provenance !== "declared"),
    crossDistrict: from.district !== to.district,
  };
}
