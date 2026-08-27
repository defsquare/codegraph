import { getProfile, renderId, type Repository } from "@codegraph/core";
import {
  CITY_ARTEFACT_KIND,
  CITY_GENERATOR,
  type Building,
  type CityModel,
  type District,
  type ResolvedBinding,
} from "./city.js";
import { layoutCity, type CityLayout, type LayoutOptions } from "./layout.js";
import { round, scaleValue, type Domain, type Range } from "./scale.js";

/**
 * The FILE-LEVEL REPLAY city (PLAN §11.1): buildings are file lineages,
 * districts are directories, and a `replay` block carries the time axis —
 * commits as ticks, building heights as sparse keyframe series. Everything
 * comes from `history.jsonl` alone; no code model is involved, so there are
 * no arrows: the city never draws a relationship the model does not contain.
 *
 * The input is a STRUCTURAL mirror of `@codegraph/scm`'s `History` — the
 * dependency between the two packages flows through the CLI, exactly as the
 * analyzer joins model and history on paths rather than on imports.
 */
export interface FileHistory {
  readonly repo: string;
  readonly authors: readonly string[];
  readonly paths: readonly string[];
  readonly commits: readonly {
    readonly hash: string;
    readonly author: number;
    readonly time: number;
    readonly isFix: boolean;
    readonly isRevert: boolean;
  }[];
  readonly changes: readonly {
    readonly commit: number;
    readonly path: number;
    readonly added: number;
    readonly deleted: number;
  }[];
}

/** One commit on the scrubber. */
export interface ReplayTick {
  readonly hash: string;
  /** Unix seconds. */
  readonly time: number;
  readonly author: string;
  readonly fix?: true;
}

/**
 * How fast change heat cools, per tick: the third keyframe element carries
 * `HEAT_DECAY^(ticks since the building last changed)` and the renderer keeps
 * decaying between keyframes — one constant, owned here, so the artifact and
 * the picture agree on what "recent" means. (The viz restates it as a literal
 * to keep the bundle Node-free; a test pins the two together.)
 */
export const REPLAY_HEAT_DECAY = 0.6;

/**
 * One keyframe: `[tick, height, heat?]`. Height in city units (the renderer
 * applies zero metric intelligence). Heat ∈ [0, 1]: 1 = the element CHANGED at
 * this tick, decayed by {@link REPLAY_HEAT_DECAY} per tick since; absent on
 * artifacts from before the channel — the renderer then treats every visible
 * keyframe as a change, which is exactly true of the file-level replay.
 */
export type ReplayKeyframe = readonly [tick: number, height: number, heat?: number];

export interface CityReplay {
  /**
   * What a tick IS: every commit of a mined history (the file-level replay,
   * M9a), or the sampled revisions of a temporal store (the entity-level
   * replay, M9c) — named so the scrubber can say which axis it walks.
   */
  readonly clock: "commits" | "revisions";
  /** Chronological, aligned with the mined history. */
  readonly ticks: readonly ReplayTick[];
  /**
   * Building id → sparse keyframes. A keyframe holds until the next one;
   * before the first the building does not exist (height 0), and height 0
   * later means the element is deleted — vacant land.
   */
  readonly series: Readonly<Record<string, readonly ReplayKeyframe[]>>;
  /**
   * Logical-coupling arcs between BUILDINGS (unordered, `a` < `b`), mined
   * from history — an INFERENCE, never a dependency: the renderer must draw
   * them visually distinct from declared arrows. Absent when no history was
   * joined; the city never draws a relationship the model does not contain.
   */
  readonly coChange?: readonly CoChangeArc[];
}

export interface CoChangeArc {
  readonly a: string;
  readonly b: string;
  /** Commits (or revisions) that touched both. */
  readonly support: number;
  /** support over the rarer side's revisions (0..1). */
  readonly confidence: number;
}

export interface ReplayCityModel extends CityModel {
  readonly replay: CityReplay;
}
export interface ReplayCityLayout extends CityLayout {
  readonly replay: CityReplay;
}

/** How a joined history reaches a builder: derived by the CALLER (the CLI
 * runs scm's `fileOwners`/`logicalCoupling` and, for the entity city, the
 * analyzer's suffix join) — the city package computes no history facts. */
export interface OwnerRef {
  readonly name: string;
  readonly share: number;
}
export interface CoChangedFiles {
  readonly a: string;
  readonly b: string;
  readonly support: number;
  readonly confidence: number;
}

export interface FileCityOptions {
  /** Display name; defaults to the history's repo name. */
  readonly name?: string;
  /** Lineage path → dominant author (scm's fileOwners rule). */
  readonly owners?: ReadonlyMap<string, OwnerRef>;
  /** Co-changed lineage-path pairs (scm's logicalCoupling rows). */
  readonly coChange?: readonly CoChangedFiles[];
}

/** `layoutCity`, keeping the replay block in the static type as well as the JSON. */
export function layoutReplayCity(city: ReplayCityModel, options: LayoutOptions = {}): ReplayCityLayout {
  return { ...layoutCity(city, options), replay: city.replay };
}

/** The M9a name for {@link layoutReplayCity}, kept: the pass never cared what a tick is. */
export const layoutFileCity = layoutReplayCity;

/** Same visual grammar as the static city: height linear, footprint-side sqrt. */
const HEIGHT_RANGE: Range = { min: 1, max: 40 };
const FOOTPRINT_RANGE: Range = { min: 2, max: 20 };

const buildingId = (path: string): string => `file:${path}`;
const districtId = (directory: string): string => `dir:${directory}`;

/** `src/a/b.txt` → `src/a`; a root file lives in `.`. */
function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "." : path.slice(0, at);
}

function basenameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * History → a laid-out replay city. Layout is computed ONCE, on every lineage
 * that EVER existed (M9c's rule, applied early): plots are frozen, buildings
 * rise from zero at birth and sink at death, and land is vacant before its
 * time — the honest picture of a city that will grow.
 */
export function buildFileCity(history: FileHistory, options: FileCityOptions = {}): ReplayCityModel {
  // Per lineage: LOC keyframes (running clamped sum of deltas), peak and final.
  interface Lineage {
    readonly path: string;
    readonly keyframes: [number, number][]; // [tick, loc]
    peak: number;
    revisions: number;
    churn: number;
  }
  const lineages: Lineage[] = history.paths.map((path) => ({
    path,
    keyframes: [],
    peak: 0,
    revisions: 0,
    churn: 0,
  }));
  const loc: number[] = history.paths.map(() => 0);
  // Changes arrive sorted by (commit, path) — the decoder's contract.
  for (const change of history.changes) {
    const lineage = lineages[change.path];
    if (lineage === undefined) continue;
    const next = Math.max(0, (loc[change.path] ?? 0) + change.added - change.deleted);
    loc[change.path] = next;
    lineage.keyframes.push([change.commit, next]);
    lineage.peak = Math.max(lineage.peak, next);
    lineage.revisions += 1;
    lineage.churn += change.added + change.deleted;
  }

  // Frozen domains, over the whole run of time: a building's height at tick T
  // must mean the same thing at every T, so the domain is the union of every
  // LOC any lineage ever reached — never the final frame's.
  const peaks = lineages.map((lineage) => lineage.peak);
  const heightDomain: Domain = { min: 0, max: peaks.length === 0 ? 0 : Math.max(...peaks) };
  const footprintDomain: Domain | undefined =
    peaks.length === 0 ? undefined : { min: Math.min(...peaks), max: Math.max(...peaks) };

  /** LOC → city units; 0 stays 0 — absence, not "minimal". */
  const heightOf = (linesOfCode: number): number =>
    linesOfCode <= 0 ? 0 : round(scaleValue(linesOfCode, heightDomain, HEIGHT_RANGE, "linear"));

  const buildings: Building[] = lineages.map((lineage) => {
    const side =
      footprintDomain === undefined
        ? FOOTPRINT_RANGE.min
        : round(scaleValue(lineage.peak, footprintDomain, FOOTPRINT_RANGE, "sqrt"));
    const final = lineage.keyframes[lineage.keyframes.length - 1]?.[1] ?? 0;
    const owner = options.owners?.get(lineage.path);
    return {
      id: buildingId(lineage.path),
      name: basenameOf(lineage.path),
      kind: "file",
      isStub: false,
      district: districtId(directoryOf(lineage.path)),
      height: heightOf(final),
      footprint: { width: side, depth: side },
      metrics: {
        loc: final,
        "peak-loc": lineage.peak,
        revisions: lineage.revisions,
        churn: lineage.churn,
      },
      attributes: [],
      operations: [],
      ...(owner === undefined ? {} : { owner }),
    };
  });

  const districts = collectDirectories(buildings);

  const bindings: ResolvedBinding[] = [
    {
      channel: "height",
      metric: "loc",
      unit: "lines",
      describe: "Running sum of the file's numstat line deltas at the current commit.",
      scale: "linear",
      range: HEIGHT_RANGE,
      domain: heightDomain,
      unmeasured: 0,
    },
    {
      channel: "footprint",
      metric: "peak-loc",
      unit: "lines",
      describe: "The largest LOC the file ever reached — the plot is frozen at its peak.",
      scale: "sqrt",
      range: FOOTPRINT_RANGE,
      domain: footprintDomain,
      unmeasured: 0,
    },
  ];

  const series: Record<string, readonly ReplayKeyframe[]> = {};
  for (const lineage of lineages) {
    // Every file keyframe IS a numstat change: heat 1 while the file lives,
    // 0 at a deletion (there is no building left to glow).
    series[buildingId(lineage.path)] = lineage.keyframes.map(
      ([tick, linesOfCode]) => [tick, heightOf(linesOfCode), linesOfCode > 0 ? 1 : 0] as const,
    );
  }

  // Lineage paths ARE building identities here: the pair maps 1:1.
  const coChange = coChangeArcsOf(options.coChange, (path) => [buildingId(path)]);

  return {
    kind: CITY_ARTEFACT_KIND,
    generatedBy: CITY_GENERATOR,
    view: { name: "all", filters: [] },
    corpus: { name: options.name ?? history.repo, roots: [history.repo] },
    conventions: {
      arrowAttachment: "roof",
      heightAxis: "y",
      groundPlane: "xz",
      units: "city",
    },
    bindings,
    districts,
    buildings,
    arrows: [],
    districtArrows: [],
    diagnostics: {
      unplacedBuildings: [],
      droppedArrows: 0,
      selfArrows: 0,
      droppedDistrictArrows: 0,
      selfDistrictArrows: 0,
      unmeasured: { loc: 0, "peak-loc": 0 },
      fold: { unfoldableEntities: 0, droppedEdges: 0, foldedEdges: 0 },
    },
    replay: {
      clock: "commits",
      ticks: history.commits.map((commit) => ({
        hash: commit.hash,
        time: commit.time,
        author: history.authors[commit.author] ?? "",
        ...(commit.isFix ? { fix: true as const } : {}),
      })),
      series,
      ...(coChange === undefined ? {} : { coChange }),
    },
  };
}

/**
 * File pairs → building arcs: unordered, deduplicated (the strongest pair
 * wins when two file pairs land on one building pair), sorted. A file that
 * raises several buildings (two top-level types in one compilation unit)
 * connects each of them — choosing one silently would be a lie.
 */
function coChangeArcsOf(
  pairs: readonly CoChangedFiles[] | undefined,
  buildingsOf: (file: string) => readonly string[],
): readonly CoChangeArc[] | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const byKey = new Map<string, CoChangeArc>();
  for (const pair of pairs) {
    for (const a of buildingsOf(pair.a)) {
      for (const b of buildingsOf(pair.b)) {
        if (a === b) continue;
        const [x, y] = a < b ? [a, b] : [b, a];
        const key = JSON.stringify([x, y]);
        const found = byKey.get(key);
        if (found === undefined || pair.support > found.support) {
          byKey.set(key, { a: x, b: y, support: pair.support, confidence: pair.confidence });
        }
      }
    }
  }
  const arcs = [...byKey.values()].sort(
    (p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0),
  );
  return arcs.length === 0 ? undefined : arcs;
}

// ───────────────────────────────────────── the entity-level replay (M9c)

/**
 * The analyzer's `readEntityHistory` output, mirrored STRUCTURALLY — the
 * dependency between the packages flows through the CLI, exactly as the
 * file history does. Series carry `[revision ordinal, loc]` for the
 * revisions that DECLARE the key; `loc` null = declared but unanchored.
 */
export interface EntityHistory {
  readonly lang: string;
  /**
   * Where the corpus lives (M10a). Its `commit` is the latest snapshot's; a
   * scrubbed link uses the TICK's sha instead, so the file it opens is the one
   * on screen.
   */
  readonly repository?: Repository;
  readonly revisions: readonly { readonly sha: string; readonly time: number | null }[];
  readonly entities: readonly {
    readonly module: string;
    readonly symbol: string;
    /** '' = none; anything else means the key is positional and shifts. */
    readonly disambiguator: string;
    /** The kind at the entity's last corpus revision. */
    readonly kind: string;
    /** The anchor file at that revision (model-relative); the joins key on it. */
    readonly file?: string | null;
    readonly series: readonly (readonly [number, number | null])[];
  }[];
}

export interface EntityCityOptions {
  /** Display name for the corpus (typically the store's basename). */
  readonly name: string;
  /** MODEL file → dominant author; the CLI joins history paths beforehand. */
  readonly owners?: ReadonlyMap<string, OwnerRef>;
  /** Co-changed MODEL-file pairs; the CLI joins history paths beforehand. */
  readonly coChange?: readonly CoChangedFiles[];
}

/**
 * Kinds that raise a building when the language ships no profile: the common
 * type nouns. With a profile, the canonical answer is the kinds whose REQUIRED
 * traits include TType — profiles are data (invariant 8), so the city derives
 * the set instead of owning a copy of the vocabulary.
 */
const FALLBACK_TYPE_KINDS: ReadonlySet<string> = new Set([
  "class", "interface", "enum", "record", "annotation", "struct", "trait", "protocol",
]);

function typeKindsOf(lang: string): ReadonlySet<string> {
  const profile = getProfile(lang);
  if (profile === undefined) return FALLBACK_TYPE_KINDS;
  return new Set(
    Object.entries(profile.kinds)
      .filter(([, spec]) => spec.required.includes("TType"))
      .map(([kind]) => kind),
  );
}

/**
 * Temporal store → a laid-out-able replay city (PLAN §11.3): every TYPE that
 * EVER existed gets a frozen plot (layout runs once, on the union), modules
 * are FLAT districts (nesting a package hierarchy from its name would be an
 * inference, the static city's rule), and the `replay` block carries one tick
 * per sampled revision. Members and anonymous types (positional
 * disambiguators — their keys shift under edits, PLAN §11 principle 3) raise
 * no building.
 *
 * A presence GAP becomes an EXPLICIT 0 keyframe: a keyframe holds until the
 * next one, so an absence the series does not state would be a lie on screen —
 * the building sinks at death and rises again at rebirth, honestly vacant
 * in between.
 */
export function buildEntityCity(history: EntityHistory, options: EntityCityOptions): ReplayCityModel {
  const typeKinds = typeKindsOf(history.lang);
  const latest = history.revisions.length - 1;

  interface Life {
    readonly module: string;
    readonly symbol: string;
    readonly kind: string;
    readonly file: string | null;
    /** Presence keyframes plus explicit 0s for gaps and death; heat carried per keyframe. */
    readonly keyframes: readonly (readonly [number, number | null, number])[];
    readonly peak: number;
    readonly finalLoc: number;
    readonly born: number;
    readonly revisions: number;
    readonly unmeasured: boolean;
  }

  const lives: Life[] = history.entities
    .filter((entity) => entity.disambiguator === "" && entity.symbol !== "" && typeKinds.has(entity.kind))
    .map((entity) => {
      const keyframes: (readonly [number, number | null, number])[] = [];
      let previous = -1;
      let previousLoc: number | null = null;
      let lastChange = 0;
      for (const [ordinal, loc] of entity.series) {
        // A skipped ordinal after a presence is a death; the next presence a rebirth.
        const reborn = previous !== -1 && ordinal > previous + 1;
        if (reborn) keyframes.push([previous + 1, 0, 0]);
        // Heat: 1 at a change (birth, rebirth, or a different LOC), pre-decayed
        // for a presence keyframe that did NOT change — sampled revisions see
        // an entity whether or not the commit touched it, unlike file commits.
        if (previous === -1 || reborn || loc !== previousLoc) lastChange = ordinal;
        keyframes.push([ordinal, loc, round(REPLAY_HEAT_DECAY ** (ordinal - lastChange))]);
        previous = ordinal;
        previousLoc = loc;
      }
      if (previous !== -1 && previous < latest) keyframes.push([previous + 1, 0, 0]);

      const measured = entity.series.map(([, loc]) => loc).filter((loc): loc is number => loc !== null);
      const last = entity.series[entity.series.length - 1];
      return {
        module: entity.module,
        symbol: entity.symbol,
        kind: entity.kind,
        file: entity.file ?? null,
        keyframes,
        peak: measured.length === 0 ? 0 : Math.max(...measured),
        finalLoc: last?.[0] === latest ? (last[1] ?? 0) : 0,
        born: entity.series[0]?.[0] ?? 0,
        revisions: entity.series.length,
        unmeasured: measured.length < entity.series.length,
      };
    })
    .sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : a.symbol < b.symbol ? -1 : 1));

  // Frozen domains over the whole run of time, as in the file city: a height
  // at tick T must mean the same thing at every T.
  const peaks = lives.map((life) => life.peak).filter((peak) => peak > 0);
  const heightDomain: Domain = { min: 0, max: peaks.length === 0 ? 0 : Math.max(...peaks) };
  const footprintDomain: Domain | undefined =
    peaks.length === 0 ? undefined : { min: Math.min(...peaks), max: Math.max(...peaks) };

  /** null = declared but unmeasured: floored to the minimum, never zeroed. */
  const heightOf = (loc: number | null): number => {
    if (loc === null) return HEIGHT_RANGE.min;
    return loc <= 0 ? 0 : round(scaleValue(loc, heightDomain, HEIGHT_RANGE, "linear"));
  };

  const idOf = (module: string, symbol: string): string =>
    renderId({ lang: history.lang, module, symbol });

  let unmeasuredCount = 0;
  const buildings: Building[] = lives.map((life) => {
    if (life.unmeasured) unmeasuredCount += 1;
    const side =
      footprintDomain === undefined || life.peak <= 0
        ? FOOTPRINT_RANGE.min
        : round(scaleValue(life.peak, footprintDomain, FOOTPRINT_RANGE, "sqrt"));
    const owner = life.file === null ? undefined : options.owners?.get(life.file);
    return {
      id: idOf(life.module, life.symbol),
      name: life.symbol,
      kind: life.kind,
      isStub: false,
      district: idOf(life.module, ""),
      height: heightOf(life.finalLoc),
      footprint: { width: side, depth: side },
      // No span: the history keys entities to a FILE, not to a line range.
      ...(life.file === null ? {} : { source: { file: life.file } }),
      metrics: {
        loc: life.finalLoc,
        "peak-loc": life.peak,
        revisions: life.revisions,
        born: life.born,
      },
      attributes: [],
      operations: [],
      ...(owner === undefined ? {} : { owner }),
    };
  });

  // Flat districts: one per module that holds a building, named by the module.
  const moduleOf = new Map<string, string>();
  for (const life of lives) moduleOf.set(idOf(life.module, ""), life.module);
  const grouped = new Map<string, Building[]>();
  for (const building of buildings) {
    const bucket = grouped.get(building.district);
    if (bucket === undefined) grouped.set(building.district, [building]);
    else bucket.push(building);
  }
  const districts: District[] = [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([districtIdent, members]) => ({
      id: districtIdent,
      name: moduleOf.get(districtIdent) ?? districtIdent,
      kind: "module",
      isStub: false,
      buildings: members.map((building) => building.id).sort(),
      footprintDemand: round(
        members.reduce((total, building) => total + building.footprint.width * building.footprint.depth, 0),
      ),
    }));

  const series: Record<string, readonly ReplayKeyframe[]> = {};
  for (const life of lives) {
    series[idOf(life.module, life.symbol)] = life.keyframes.map(
      ([ordinal, loc, heat]) => [ordinal, heightOf(loc), heat] as const,
    );
  }

  // A model file can raise several buildings (a second top-level type in one
  // compilation unit); each of them takes part in the file's co-changes.
  const buildingsByFile = new Map<string, string[]>();
  for (const life of lives) {
    if (life.file === null) continue;
    const bucket = buildingsByFile.get(life.file);
    const buildingIdent = idOf(life.module, life.symbol);
    if (bucket === undefined) buildingsByFile.set(life.file, [buildingIdent]);
    else bucket.push(buildingIdent);
  }
  const coChange = coChangeArcsOf(options.coChange, (file) => buildingsByFile.get(file) ?? []);

  return {
    kind: CITY_ARTEFACT_KIND,
    generatedBy: CITY_GENERATOR,
    view: { name: "internal", filters: ["internal-only"] },
    corpus: {
      name: options.name,
      roots: [],
      ...(history.repository === undefined ? {} : { repository: history.repository }),
    },
    conventions: {
      arrowAttachment: "roof",
      heightAxis: "y",
      groundPlane: "xz",
      units: "city",
    },
    bindings: [
      {
        channel: "height",
        metric: "loc",
        unit: "lines",
        describe: "Anchor span lines of the type at the scrubbed revision.",
        scale: "linear",
        range: HEIGHT_RANGE,
        domain: heightDomain,
        unmeasured: unmeasuredCount,
      },
      {
        channel: "footprint",
        metric: "peak-loc",
        unit: "lines",
        describe: "The largest LOC the type ever reached — the plot is frozen at its peak.",
        scale: "sqrt",
        range: FOOTPRINT_RANGE,
        domain: footprintDomain,
        unmeasured: unmeasuredCount,
      },
    ],
    districts,
    buildings,
    arrows: [],
    districtArrows: [],
    diagnostics: {
      unplacedBuildings: [],
      droppedArrows: 0,
      selfArrows: 0,
      droppedDistrictArrows: 0,
      selfDistrictArrows: 0,
      unmeasured: { loc: unmeasuredCount, "peak-loc": unmeasuredCount },
      fold: { unfoldableEntities: 0, droppedEdges: 0, foldedEdges: 0 },
    },
    replay: {
      clock: "revisions",
      ticks: history.revisions.map((revision) => ({
        hash: revision.sha,
        time: revision.time ?? 0,
        author: "",
      })),
      series,
      ...(coChange === undefined ? {} : { coChange }),
    },
  };
}

/**
 * Districts are exactly the directories that directly hold a lineage —
 * empty ground nobody stands on is not part of the city (the static city's
 * rule). Nesting follows the nearest ANCESTOR directory that is itself a
 * district, so `src/a/b` can sit straight inside `src` when `src/a` holds
 * no files of its own.
 */
function collectDirectories(buildings: readonly Building[]): readonly District[] {
  const grouped = new Map<string, Building[]>();
  for (const building of buildings) {
    const bucket = grouped.get(building.district);
    if (bucket === undefined) grouped.set(building.district, [building]);
    else bucket.push(building);
  }
  const ids = new Set(grouped.keys());

  const parentOf = (id: string): string | undefined => {
    let directory = id.slice("dir:".length);
    while (directory !== ".") {
      const at = directory.lastIndexOf("/");
      directory = at === -1 ? "." : directory.slice(0, at);
      const candidate = districtId(directory);
      if (ids.has(candidate)) return candidate;
    }
    return undefined;
  };

  return [...grouped.keys()].sort().map((id) => {
    const members = grouped.get(id) ?? [];
    const directory = id.slice("dir:".length);
    const parent = parentOf(id);
    return {
      id,
      name: directory === "." ? "." : basenameOf(directory),
      kind: "directory",
      isStub: false,
      ...(parent === undefined ? {} : { parent }),
      buildings: members.map((building) => building.id).sort(),
      footprintDemand: round(
        members.reduce(
          (total, building) => total + building.footprint.width * building.footprint.depth,
          0,
        ),
      ),
    };
  });
}
