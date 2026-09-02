import {
  INSIGHTS_KIND,
  InsightRecord,
  InsightsEof,
  InsightsHeader,
  type Level,
} from "./schema.js";

/**
 * THE SIDE-CAR FILE: `<model>.insights.jsonl`. One JSON record per line —
 * a header, the records sorted by (level, id), an eof trailer — beside the
 * model and never inside it, so it can be regenerated, switched to another
 * model or deleted without touching `model.jsonl`/`model.db`.
 *
 * DETERMINISTIC BODY. Given the same records the body is the same bytes; the
 * only timestamp lives in the trailer. That makes two runs diffable: what
 * changed is what the model re-explained, and nothing else.
 *
 * THE JOURNAL. During a run, finished records are appended one per line to
 * `<out>.journal`; the sorted file is rewritten from base + journal at each
 * layer boundary and at the end. A crash leaves a journal whose last line may
 * be cut — reading it is lenient — while the side-car proper is strict.
 */

export const LEVEL_RANK: Readonly<Record<Level, number>> = { operation: 0, type: 1, module: 2 };

export interface InsightsFile {
  readonly header: InsightsHeader;
  readonly records: readonly InsightRecord[];
  readonly eof: InsightsEof | undefined;
  /** No eof, or counts disagreeing with it: the file was cut short. */
  readonly truncated: boolean;
}

export class InsightsFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InsightsFileError";
  }
}

export function compareRecords(a: InsightRecord, b: InsightRecord): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortRecords(records: Iterable<InsightRecord>): InsightRecord[] {
  return [...records].sort(compareRecords);
}

export function recordsById(records: Iterable<InsightRecord>): Map<string, InsightRecord> {
  const out = new Map<string, InsightRecord>();
  for (const record of records) out.set(record.id, record);
  return out;
}

/** Base ∪ journal, the journal winning on an id; sorted. */
export function mergeRecords(base: Iterable<InsightRecord>, journal: Iterable<InsightRecord>): InsightRecord[] {
  const merged = recordsById(base);
  for (const record of journal) merged.set(record.id, record);
  return sortRecords(merged.values());
}

/** Key order normalized through the schema: a record built in memory and one read back serialize alike. */
export function encodeRecord(record: InsightRecord): string {
  return JSON.stringify(InsightRecord.parse(record));
}

export function* encodeInsights(
  header: InsightsHeader,
  records: Iterable<InsightRecord>,
  eof: InsightsEof,
): Generator<string> {
  yield JSON.stringify(InsightsHeader.parse(header));
  for (const record of sortRecords(records)) yield encodeRecord(record);
  yield JSON.stringify(InsightsEof.parse(eof));
}

export function encodeInsightsToString(header: InsightsHeader, records: Iterable<InsightRecord>, eof: InsightsEof): string {
  return `${[...encodeInsights(header, records, eof)].join("\n")}\n`;
}

export function encodeJournalLine(record: InsightRecord): string {
  return `${encodeRecord(record)}\n`;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** Strict: the header must be ours, every body line a valid record. */
export function decodeInsights(text: string): InsightsFile {
  const lines = nonEmptyLines(text);
  const first = lines[0];
  if (first === undefined) throw new InsightsFileError("empty insights file");
  let headerJson: unknown;
  try {
    headerJson = JSON.parse(first);
  } catch (error) {
    throw new InsightsFileError("line 1 is not JSON", { cause: error });
  }
  const header = InsightsHeader.safeParse(headerJson);
  if (!header.success) {
    throw new InsightsFileError(`line 1 is not a ${INSIGHTS_KIND} header: ${header.error.issues[0]?.message ?? "invalid"}`);
  }
  const records: InsightRecord[] = [];
  let eof: InsightsEof | undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new InsightsFileError(`line ${i + 1} is not JSON`, { cause: error });
    }
    const tag = (json as { t?: unknown } | null)?.t;
    if (tag === "eof") {
      const parsed = InsightsEof.safeParse(json);
      if (!parsed.success) throw new InsightsFileError(`line ${i + 1}: invalid eof record`);
      eof = parsed.data;
      continue;
    }
    const parsed = InsightRecord.safeParse(json);
    if (!parsed.success) {
      throw new InsightsFileError(`line ${i + 1}: invalid insight record: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    records.push(parsed.data);
  }
  return {
    header: header.data,
    records,
    eof,
    truncated: eof === undefined || eof.counts.records !== records.length,
  };
}

/** Lenient: a journal may end mid-line after a crash; unparsable lines are dropped and counted. */
export function decodeJournal(text: string): { records: InsightRecord[]; dropped: number } {
  const records: InsightRecord[] = [];
  let dropped = 0;
  for (const line of nonEmptyLines(text)) {
    try {
      const parsed = InsightRecord.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  return { records, dropped };
}
