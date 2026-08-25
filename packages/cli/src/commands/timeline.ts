import { parseRenderedId, type NaturalKey } from "@codegraph/core";
import {
  listRevisions,
  openStore,
  readTimeline,
  storePathFor,
  type Timeline,
} from "@codegraph/analyzer";
import { defaultModelPath, type TimelineOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { outLines, type IoSink } from "../io.js";

/**
 * `codegraph timeline <id> [--store FILE] [--json]` (M9b, PLAN §11.2).
 *
 * The entity's life across the revisions a temporal store accumulated:
 * appeared, last seen, still-present, and the LOC series between them —
 * all DERIVED by the query, never stored (invariant 4 on the time axis).
 *
 * The id arrives in rendered form because that is what every report prints;
 * decoding it here is decoding USER INPUT with core's own verified inverse,
 * not parsing an id the pipeline carries (invariant 7 stays intact).
 *
 * A key no revision declares is an ANSWER (exit 0), not an error: the store
 * was read, and "never appeared" is what it says. Anonymous entities
 * (positional disambiguators) get an answer too, but their keys shift under
 * edits — the report cannot follow them across revisions (PLAN §11.3 note).
 */
export function timelineCommand(options: TimelineOptions, io: IoSink): ExitCode {
  const storePath = options.store ?? storePathFor(defaultModelPath());

  let key: NaturalKey;
  try {
    key = parseRenderedId(options.id);
  } catch (error) {
    throw new UsageError(
      `'${options.id}' is not a rendered entity id`,
      "Expected lang:module/symbol — e.g. java:com.acme.order/Basket — as reports print them.",
      { cause: error },
    );
  }

  let db: ReturnType<typeof openStore>;
  try {
    db = openStore(storePath);
  } catch (error) {
    throw new UsageError(
      `cannot open the store at ${storePath}`,
      "Build a temporal store first: codegraph import <model.jsonl> --at <sha> --time <t> --out " +
        storePath,
      { cause: error },
    );
  }

  try {
    const revisions = listRevisions(db);
    if (revisions.length === 0) {
      throw new UsageError(
        `${storePath} holds no revisions — it is a plain single-model cache`,
        "Append snapshots with: codegraph import <model.jsonl> --at <sha> --time <t> --out " +
          storePath,
      );
    }

    const lang = db.prepare("SELECT value FROM meta WHERE key = 'lang'").get()?.value as
      | string
      | undefined;
    const timeline =
      lang !== undefined && lang !== key.lang
        ? undefined
        : readTimeline(db, {
            module: key.module,
            symbol: key.symbol,
            disambiguator: key.disambiguator,
          });

    if (timeline === undefined) {
      const note =
        lang !== undefined && lang !== key.lang
          ? ` (the store is ${lang}; the id says ${key.lang})`
          : "";
      outLines(io, [
        `${options.id} never appears in any of the ${revisions.length} revisions of ${storePath}${note}.`,
      ]);
      return EXIT.OK;
    }

    outLines(
      io,
      options.json
        ? [JSON.stringify({ id: options.id, store: storePath, revisions: revisions.length, ...timeline }, null, 2)]
        : renderText(options.id, storePath, revisions.length, timeline),
    );
    return EXIT.OK;
  } finally {
    db.close();
  }
}

function day(unixSeconds: number | null): string {
  return unixSeconds === null ? "?" : new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function renderText(
  id: string,
  storePath: string,
  revisionCount: number,
  timeline: Timeline,
): readonly string[] {
  const lines = [
    `timeline of ${id} (${timeline.series.length} of ${revisionCount} revisions in ${storePath})`,
  ];
  lines.push(`  appeared:  ${short(timeline.appeared.sha)} (${day(timeline.appeared.time)})`);
  lines.push(
    timeline.presentInLatest
      ? `  present:   still in the latest revision`
      : `  last seen: ${short(timeline.lastSeen.sha)} (${day(timeline.lastSeen.time)}) — gone since`,
  );

  const header = ["REVISION", "DATE", "LOC", "KIND"];
  const rows = timeline.series.map((point) => [
    short(point.sha),
    day(point.time),
    point.loc === null ? "-" : String(point.loc),
    point.isStub ? `${point.kind} (stub)` : point.kind,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (row: readonly string[]): string =>
    "  " +
    row
      .map((cell, column) => (column === 2 ? cell.padStart(widths[2] ?? 0) : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();
  lines.push(render(header), ...rows.map(render));
  return lines;
}
