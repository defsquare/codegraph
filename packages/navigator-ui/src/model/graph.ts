import type { NavigatorModel, NavNode } from "@codegraph/navigator";

/**
 * DISPLAY aggregation for the graph tab — presentation only, like the package
 * fold. Dep rows arrive owned by type/module nodes with provenance attached;
 * this layer only decides which precomputed rows one drawing shows and sums
 * them per node pair. No graph fact is derived: fan-in comes from the
 * artifact's `metrics`, provenance from each row, cycles from `reports`.
 *
 * Two modes, the audit-tools arch_viz pair:
 *   types    every type-category node with at least one visible link, hung
 *            under its module (the compound cluster);
 *   modules  rows rolled up to the nearest owning module of each endpoint —
 *            intra-module rows are cohesion and never drawn.
 */
export type GraphMode = "modules" | "types";

export interface GraphFilter {
  readonly mode: GraphMode;
  /** Drop stub endpoints and every link that touches one. */
  readonly hideExternals: boolean;
  /** Keep only nodes whose precomputed fan-in reaches this floor. */
  readonly minFanIn: number;
  /** Most nodes one drawing renders; the rest are cut by fan-in rank. */
  readonly cap?: number;
}

export interface GraphDisplayNode {
  /** Artifact node index — the shared address with every other tab. */
  readonly node: number;
  readonly label: string;
  readonly stub: boolean;
  /** Precomputed metric; 0 when the artifact carries none for this node. */
  readonly fanIn: number;
  /** Compound parent (types mode): the nearest self-or-ancestor module. */
  readonly module: number | undefined;
  /** Categorical color slot — same module, same slot. */
  readonly hue: number;
}

export interface GraphDisplayEdge {
  readonly from: number;
  readonly to: number;
  /** Dep rows aggregated into this link. */
  readonly count: number;
  /** False as soon as one aggregated row is an inference (invariant 2). */
  readonly allDeclared: boolean;
}

export interface GraphDisplay {
  readonly nodes: readonly GraphDisplayNode[];
  readonly edges: readonly GraphDisplayEdge[];
  /** Nodes that passed the filters, before the cap. */
  readonly totalNodes: number;
  readonly truncated: boolean;
}

/**
 * The default drawing size. It was 1,200 — a hairball that took TWO MINUTES
 * to lay out and read as one solid blob when it finally appeared. The cost
 * curve is worse than quadratic past ~400 nodes (see `layout.ts`), so the
 * default is the largest size that still lands near a second; the toolbar
 * offers the bigger ones to anyone who wants to wait for them.
 */
export const DEFAULT_GRAPH_CAP = 300;

/** Categorical palette size; hues are assigned by hashing the hue KEY. */
export const HUE_SLOTS = 12;

/**
 * The hue scheme is CORPUS-RELATIVE. Hashing every package separately turns a
 * 500-package corpus into confetti; hashing a fixed vendor prefix melts a
 * single-vendor corpus into one color. So: inside the corpus's common dotted
 * prefix, the key is that prefix plus the next `depth` segments, where depth
 * is the SMALLEST that separates the corpus into enough groups — its
 * functional areas (`…blpm.domain`, `…blpm.exposition`); outside it (the
 * externals), the first two segments — the vendor (`org.springframework`).
 * Display-name splitting, like fold.ts — never id parsing.
 */
export interface HueScheme {
  /** Longest common dotted prefix of the corpus's own module names; may be "". */
  readonly prefix: string;
  /** Segments kept below the prefix. */
  readonly depth: number;
}

/** Fewest corpus color groups worth having, when the corpus can yield them. */
const MIN_HUE_GROUPS = 5;
const MAX_HUE_DEPTH = 4;

export function hueKeyOf(moduleName: string, scheme?: HueScheme): string {
  const prefix = scheme?.prefix ?? "";
  if (prefix !== "" && (moduleName === prefix || moduleName.startsWith(`${prefix}.`))) {
    const rest = moduleName
      .slice(prefix.length)
      .split(".")
      .filter((segment) => segment !== "")
      .slice(0, scheme?.depth ?? 2);
    return [prefix, ...rest].join(".");
  }
  const segments = moduleName.split(".");
  return segments.length <= 2 ? moduleName : `${segments[0]}.${segments[1]}`;
}

export function corpusHueScheme(model: NavigatorModel): HueScheme {
  // Longest common dotted prefix over the corpus's own (non-stub) modules.
  let prefix: string[] | undefined;
  const names: string[] = [];
  for (const node of model.nodes) {
    if (node.category !== "module" || node.isStub) continue;
    names.push(node.name);
    const segments = node.name.split(".");
    if (segments.length < 2) return { prefix: "", depth: 2 };
    if (prefix === undefined) {
      prefix = segments;
      continue;
    }
    let shared = 0;
    while (shared < prefix.length && shared < segments.length && prefix[shared] === segments[shared]) {
      shared += 1;
    }
    prefix.length = shared;
    if (shared === 0) return { prefix: "", depth: 2 };
  }
  if (prefix === undefined || prefix.length === 0) return { prefix: "", depth: 2 };
  const joined = prefix.join(".");

  // Smallest depth that separates the corpus into enough groups; a corpus
  // with fewer distinct names than the target settles for what it has.
  const target = Math.min(MIN_HUE_GROUPS, new Set(names).size);
  for (let depth = 1; depth <= MAX_HUE_DEPTH; depth += 1) {
    const scheme = { prefix: joined, depth };
    const groups = new Set(names.map((name) => hueKeyOf(name, scheme)));
    if (groups.size >= target) return scheme;
  }
  return { prefix: joined, depth: MAX_HUE_DEPTH };
}

/** FNV-1a over the hue key — stable across loads and filters. */
export function hueOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % HUE_SLOTS;
}

/** Nearest self-or-ancestor module-category node. */
function moduleOf(model: NavigatorModel, node: number): number | undefined {
  let cursor: number | undefined = node;
  while (cursor !== undefined) {
    const entry: NavNode | undefined = model.nodes[cursor];
    if (entry === undefined) return undefined;
    if (entry.category === "module") return cursor;
    cursor = entry.parent;
  }
  return undefined;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function graphDisplay(model: NavigatorModel, filter: GraphFilter): GraphDisplay {
  const cap = filter.cap ?? DEFAULT_GRAPH_CAP;

  // --- resolve each dep row to a drawable pair -----------------------------
  const pairs = new Map<string, { from: number; to: number; count: number; allDeclared: boolean }>();
  const moduleCache = new Map<number, number | undefined>();
  const owningModule = (node: number): number | undefined => {
    const cached = moduleCache.get(node);
    if (cached !== undefined || moduleCache.has(node)) return cached;
    const resolved = moduleOf(model, node);
    moduleCache.set(node, resolved);
    return resolved;
  };

  const endpointOk = (node: number): boolean => {
    const entry = model.nodes[node];
    if (entry === undefined) return false;
    if (filter.hideExternals && entry.isStub) return false;
    if (filter.mode === "types" && entry.category !== "type") return false;
    if (filter.mode === "types" && (entry.metrics?.fanIn ?? 0) < filter.minFanIn) return false;
    return true;
  };

  for (const dep of model.deps) {
    let from: number | undefined;
    let to: number | undefined;
    if (filter.mode === "modules") {
      from = owningModule(dep.from);
      to = owningModule(dep.to);
      if (from === undefined || to === undefined || from === to) continue;
      if (filter.hideExternals && (model.nodes[from]?.isStub || model.nodes[to]?.isStub)) continue;
    } else {
      if (!endpointOk(dep.from) || !endpointOk(dep.to)) continue;
      from = dep.from;
      to = dep.to;
    }
    const key = `${from}:${to}`;
    const bucket = pairs.get(key);
    const declared = dep.provenance === "declared";
    if (bucket === undefined) pairs.set(key, { from, to, count: 1, allDeclared: declared });
    else {
      bucket.count += 1;
      bucket.allDeclared &&= declared;
    }
  }

  // --- the node set: everything a kept pair touches ------------------------
  const touched = new Set<number>();
  for (const pair of pairs.values()) {
    touched.add(pair.from);
    touched.add(pair.to);
  }

  const ranked = [...touched].sort((a, b) => {
    const fa = model.nodes[a]?.metrics?.fanIn ?? 0;
    const fb = model.nodes[b]?.metrics?.fanIn ?? 0;
    return fb - fa || compareStrings(model.nodes[a]?.name ?? "", model.nodes[b]?.name ?? "") || a - b;
  });
  const totalNodes = ranked.length;
  const kept = new Set(ranked.slice(0, cap));

  const scheme = corpusHueScheme(model);
  const nodes: GraphDisplayNode[] = [];
  for (const node of ranked.slice(0, cap)) {
    const entry = model.nodes[node];
    if (entry === undefined) continue;
    const module = filter.mode === "types" ? owningModule(node) : undefined;
    const hueSource =
      filter.mode === "modules"
        ? entry.name
        : module === undefined
          ? entry.name
          : (model.nodes[module]?.name ?? entry.name);
    nodes.push({
      node,
      label: entry.name,
      stub: entry.isStub,
      fanIn: entry.metrics?.fanIn ?? 0,
      module,
      hue: hueOf(hueKeyOf(hueSource, scheme)),
    });
  }

  const edges: GraphDisplayEdge[] = [];
  for (const pair of pairs.values()) {
    if (!kept.has(pair.from) || !kept.has(pair.to)) continue;
    edges.push({ from: pair.from, to: pair.to, count: pair.count, allDeclared: pair.allDeclared });
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to);

  return { nodes, edges, totalNodes, truncated: totalNodes > cap };
}
