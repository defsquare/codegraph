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

export interface CityReplay {
  /** What a tick IS. Commits are the only clock M9a knows. */
  readonly clock: "commits";
  /** Chronological, aligned with the mined history. */
  readonly ticks: readonly ReplayTick[];
  /**
   * Building id → sparse `[tick, height]` keyframes, height ALREADY in city
   * units (the renderer applies zero metric intelligence). A height holds
   * until the next keyframe; before the first the building does not exist
   * (height 0), and height 0 later means the file is deleted — vacant land.
   */
  readonly series: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

export interface ReplayCityModel extends CityModel {
  readonly replay: CityReplay;
}
export interface ReplayCityLayout extends CityLayout {
  readonly replay: CityReplay;
}

export interface FileCityOptions {
  /** Display name; defaults to the history's repo name. */
  readonly name?: string;
}

/** `layoutCity`, keeping the replay block in the static type as well as the JSON. */
export function layoutFileCity(city: ReplayCityModel, options: LayoutOptions = {}): ReplayCityLayout {
  return { ...layoutCity(city, options), replay: city.replay };
}

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

  const series: Record<string, readonly (readonly [number, number])[]> = {};
  for (const lineage of lineages) {
    series[buildingId(lineage.path)] = lineage.keyframes.map(
      ([tick, linesOfCode]) => [tick, heightOf(linesOfCode)] as const,
    );
  }

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
