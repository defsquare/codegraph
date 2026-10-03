import { existsSync, readFileSync } from "node:fs";
import { renderId, type SourceAnchor } from "@codegraph/core";
import type { MetricSource } from "@codegraph/city";
import { HISTORY_MEASURES, decodeHistoryMetricsText } from "@codegraph/scm";
import { UsageError } from "./exit.js";

/**
 * THE JOIN OF A MODEL AND ITS CHANGE HISTORY (PLAN §18.2). History is
 * measured into a side-car, never into the model (PLAN §11, principle 1);
 * this module joins the two in memory — an entity record on the natural key
 * it carries, rendered to the model's id; a file record on the model's path —
 * and offers the result to the city as metric sources:
 *
 *   history:<measure>       the building's own entity (its type's blame)
 *   history-file:<measure>  the file the building's type is written in
 *
 * Nothing joined here is ever written back into a model.
 */

export const HISTORY_ENTITY_PREFIX = "history:";
export const HISTORY_FILE_PREFIX = "history-file:";

/** `X.jsonl` → `X.history-metrics.jsonl`: where `codegraph-metrics --history` writes. */
export function historyMetricsPathFor(modelPath: string): string {
  const stem = modelPath.endsWith(".jsonl") ? modelPath.slice(0, -".jsonl".length) : modelPath;
  return `${stem}.history-metrics.jsonl`;
}

export interface HistoryJoin {
  /** The side-cars read, for messages. */
  readonly paths: readonly string[];
  readonly byId: ReadonlyMap<string, Readonly<Record<string, number>>>;
  readonly byFile: ReadonlyMap<string, Readonly<Record<string, number>>>;
}

/**
 * The side-car `--history-metrics FILE` names, else the one beside each model
 * that has one; undefined when there is none — a model nobody measured.
 */
export function loadHistoryJoin(explicit: string | undefined, models: readonly string[]): HistoryJoin | undefined {
  if (explicit !== undefined && !existsSync(explicit)) {
    throw new UsageError(`--history-metrics ${explicit}: no such file`);
  }
  const paths = explicit !== undefined ? [explicit] : models.map(historyMetricsPathFor).filter((path) => existsSync(path));
  if (paths.length === 0) return undefined;
  const byId = new Map<string, Record<string, number>>();
  const byFile = new Map<string, Record<string, number>>();
  for (const path of paths) {
    try {
      const metrics = decodeHistoryMetricsText(readFileSync(path, "utf8"));
      for (const { key, vcs } of metrics.entities) byId.set(renderId(key), vcs);
      for (const { path: file, vcs } of metrics.files) if (!byFile.has(file)) byFile.set(file, vcs);
    } catch (error) {
      // A corrupt side-car or a key core cannot render: either way, not this model's history.
      const message = error instanceof Error ? error.message : String(error);
      throw new UsageError(`${path}: ${message}`, "Rewrite it with 'codegraph-metrics <model.jsonl> --history'.");
    }
  }
  return { paths, byId, byFile };
}

/**
 * The source a `history:`/`history-file:` name stands for; undefined for any
 * other name, which the city package resolves itself.
 */
export function historyMetric(name: string, join: HistoryJoin | undefined): MetricSource | undefined {
  const level = name.startsWith(HISTORY_ENTITY_PREFIX) ? "entity" : name.startsWith(HISTORY_FILE_PREFIX) ? "file" : undefined;
  if (level === undefined) return undefined;
  const key = name.slice(level === "entity" ? HISTORY_ENTITY_PREFIX.length : HISTORY_FILE_PREFIX.length);
  const measure = HISTORY_MEASURES[key];
  if (measure === undefined || !Object.hasOwn(HISTORY_MEASURES, key)) {
    throw new UsageError(
      `unknown history measure in ${name}`,
      `Measures: ${Object.keys(HISTORY_MEASURES).join(", ")}.`,
    );
  }
  if (!measure.levels.includes(level)) {
    const other = level === "entity" ? HISTORY_FILE_PREFIX : HISTORY_ENTITY_PREFIX;
    throw new UsageError(`${key} is measured per ${measure.levels.join(" and ")} only: use ${other}${key}`);
  }
  if (join === undefined) {
    throw new UsageError(
      `${name} needs the model's change-history side-car, and there is none beside it`,
      "Run 'codegraph-metrics <model.jsonl> --history' first, or name one with --history-metrics FILE.",
    );
  }
  if (level === "entity") {
    return {
      name,
      unit: measure.unit,
      describe: `${measure.describe} The type's own blame.`,
      value: ({ entity }) => (entity === undefined ? undefined : join.byId.get(entity.id)?.[key]),
    };
  }
  return {
    name,
    unit: measure.unit,
    describe: `${measure.describe} Of the file the type is written in.`,
    value: ({ entity }) => {
      const anchor = (entity as Record<string, unknown> | undefined)?.["anchor"] as SourceAnchor | undefined;
      return anchor === undefined ? undefined : join.byFile.get(anchor.file)?.[key];
    },
  };
}
