import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Edge, Entity, Model } from "../src/model/model.js";
import { renderKey } from "../src/model/keys.js";
import { extract } from "../src/extraction.js";
import { VERSION } from "../src/main.js";
import { Progress } from "../src/progress.js";
import { repoRoot } from "./harness.js";

/**
 * Codegraph over codegraph (PLAN.md §14.6, the DoD of the phase): the
 * model of this repository, and the architecture rules CLAUDE.md states,
 * restated as graph queries over it. Shared by the self-hosting test and
 * the audit script.
 */

export interface SelfHost {
  readonly model: Model;
  readonly stats: import("../src/stats.js").ResolutionStats;
  readonly seconds: number;
}

export function selfHost(): SelfHost {
  const started = process.hrtime.bigint();
  const result = extract(
    {
      sources: ["packages", "extractors/typescript"],
      cwd: repoRoot(),
      repository: undefined,
      tsconfig: undefined,
      allowJs: false,
      ignoreNodeModules: false,
    },
    Progress.silent(),
    VERSION,
  );
  return { model: result.model, stats: result.stats, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
}

export function hasWorkspaceInstall(): boolean {
  return existsSync(join(repoRoot(), "node_modules", "typescript", "package.json"));
}

/** The workspace package a corpus entity belongs to (`packages/<name>` or `extractors/typescript`), else undefined. */
export function packageOf(entity: Entity): string | undefined {
  const module = entity.key.module;
  const match = /^(packages%2F[^%]+|extractors%2Ftypescript)%2F/.exec(module);
  return match?.[1]?.replaceAll("%2F", "/");
}

/** `src/` code only: tests import freely and are not the architecture. */
export function isSource(entity: Entity): boolean {
  return /%2Fsrc%2F/.test(entity.key.module);
}

export interface PackageEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: Edge["kind"];
  readonly edge: Edge;
}

/** Every edge between two DIFFERENT workspace packages, source code only. */
export function crossPackageEdges(model: Model): PackageEdge[] {
  const byKey = new Map(model.entities.map((entity) => [renderKey(entity.key), entity]));
  const out: PackageEdge[] = [];
  for (const edge of model.edges) {
    const from = byKey.get(renderKey(edge.from));
    const to = byKey.get(renderKey(edge.to));
    if (from === undefined || to === undefined) continue;
    if (!isSource(from) || !isSource(to)) continue;
    const a = packageOf(from);
    const b = packageOf(to);
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ from: a, to: b, kind: edge.kind, edge });
  }
  return out;
}

/** Strongly connected components of the package-level dependency graph (Tarjan). */
export function packageCycles(edges: readonly PackageEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from)?.add(to);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, indices.get(next) as number));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop() as string;
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
      }
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of [...adjacency.keys()].sort()) if (!indices.has(node)) visit(node);
  return components;
}

/** The entity an edge points at, for the "types only" rule. */
export function targetOf(model: Model, edge: Edge): Entity | undefined {
  const id = renderKey(edge.to);
  return model.entities.find((entity) => renderKey(entity.key) === id);
}
