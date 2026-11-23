import { EXPLAIN_RECORDS, describeWalk, mismatchPhrase, storedWalkOf, walkMismatch, type RecordFormat } from "./format.js";
import {
  FailureRecord,
  InsightRecord,
  InsightsEof,
  type InsightsHeader,
  type Level,
  type StoreHeader,
  type WalkRecord,
} from "./schema.js";

/**
 * THE SIDE-CAR FILE: `<model>.insights.jsonl`. One JSON record per line —
 * a header, the records sorted by (level, id), the failures (`t:"f"`, same
 * order: the units asked for and left without a record, with the reason), an
 * eof trailer — beside the model and never inside it, so it can be regenerated, switched to another
 * model or deleted without touching `model.jsonl`/`model.db`.
 *
 * DETERMINISTIC BODY. Given the same records the body is the same bytes; the
 * only timestamp lives in the trailer. That makes two runs diffable: what
 * changed is what the model re-explained, and nothing else.
 *
 * AN EXPORT SINCE M16a. `explain` works against the insights store
 * (store.ts) and writes this file from it, whole, when a run ends; the
 * encoder here is what `decode → import → export` is measured against.
 *
 * THE JOURNAL IS LEGACY. Builds before M16a appended finished records to
 * `<out>.journal` and rewrote the sorted file at each layer. Nothing writes
 * one any more; the lenient reader stays so that a journal an older build
 * left behind — its last line possibly cut — is merged on first contact.
 *
 * ONE CODEC FOR EVERY WALK (PLAN.md §22.4). `encodeRecords`/`decodeRecords` are
 * handed the walk's `RecordFormat`: the envelopes (record, failure, trailer) are
 * the same for all, the block is checked by the walk's own schema on the way in
 * and out, and a file whose header names another walk is refused at line 1.
 * The `…Insights` functions are explain's instance of it.
 */

export const LEVEL_RANK: Readonly<Record<Level, number>> = { operation: 0, type: 1, module: 2 };

export interface InsightsFile<R extends WalkRecord = InsightRecord, H extends StoreHeader = InsightsHeader> {
  readonly header: H;
  readonly records: readonly R[];
  /** Units the last runs asked for and could not explain — what `--retry-failed` redoes. */
  readonly failures: readonly FailureRecord[];
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

export function compareRecords(a: WalkRecord, b: WalkRecord): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortRecords<R extends WalkRecord>(records: Iterable<R>): R[] {
  return [...records].sort(compareRecords);
}

export function sortFailures(failures: Iterable<FailureRecord>): FailureRecord[] {
  return [...failures].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function recordsById<R extends WalkRecord>(records: Iterable<R>): Map<string, R> {
  const out = new Map<string, R>();
  for (const record of records) out.set(record.id, record);
  return out;
}

/** Base ∪ journal, the journal winning on an id; sorted. */
export function mergeRecords<R extends WalkRecord>(base: Iterable<R>, journal: Iterable<R>): R[] {
  const merged = recordsById(base);
  for (const record of journal) merged.set(record.id, record);
  return sortRecords(merged.values());
}

/** Key order normalized through the schema: a record built in memory and one read back serialize alike. */
export function encodeRecord(record: InsightRecord): string {
  return JSON.stringify(InsightRecord.parse(record));
}

/** A reader's format (`walkReader`) holds no block schema: a side-car is neither written nor read through it. */
function refuseReader(format: Pick<RecordFormat, "name" | "kind" | "readOnly">): void {
  if (format.readOnly === true) {
    throw new InsightsFileError(`${describeWalk(format)} is read here without its definition: a side-car is encoded and decoded only by the walk's own definition`);
  }
}

/** A walk's side-car, line by line: its header (refused if another walk's), its records sorted, its failures, the trailer. */
export function* encodeRecords<R extends WalkRecord, H extends StoreHeader>(
  format: RecordFormat<R, H>,
  header: H,
  records: Iterable<R>,
  eof: InsightsEof,
  failures: Iterable<FailureRecord> = [],
): Generator<string> {
  refuseReader(format);
  const found = storedWalkOf(header);
  const mismatch = found === undefined ? "walk" : walkMismatch(found, format);
  if (mismatch !== undefined) {
    throw new InsightsFileError(found === undefined ? `this header is no walk's, not of ${describeWalk(format)}` : `this header is ${mismatchPhrase(found, format, mismatch)}`);
  }
  yield JSON.stringify(format.header.parse(header));
  for (const record of sortRecords(records)) yield JSON.stringify(format.record.parse(record));
  for (const failure of sortFailures(failures)) yield JSON.stringify(FailureRecord.parse(failure));
  yield JSON.stringify(InsightsEof.parse(eof));
}

export function encodeRecordsToString<R extends WalkRecord, H extends StoreHeader>(
  format: RecordFormat<R, H>,
  header: H,
  records: Iterable<R>,
  eof: InsightsEof,
  failures: Iterable<FailureRecord> = [],
): string {
  return `${[...encodeRecords(format, header, records, eof, failures)].join("\n")}\n`;
}

export function encodeInsights(
  header: InsightsHeader,
  records: Iterable<InsightRecord>,
  eof: InsightsEof,
  failures: Iterable<FailureRecord> = [],
): Generator<string> {
  return encodeRecords(EXPLAIN_RECORDS, header, records, eof, failures);
}

export function encodeInsightsToString(
  header: InsightsHeader,
  records: Iterable<InsightRecord>,
  eof: InsightsEof,
  failures: Iterable<FailureRecord> = [],
): string {
  return encodeRecordsToString(EXPLAIN_RECORDS, header, records, eof, failures);
}

export function encodeJournalLine(record: InsightRecord): string {
  return `${encodeRecord(record)}\n`;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** The first issue of a refused line, with its path inside the line when it has one. */
function issueOf(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }, withPath: boolean): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid";
  return withPath && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message;
}

/** Explain's side-car (`decodeRecords` with explain's format). */
export function decodeInsights(text: string): InsightsFile {
  return decodeRecords(EXPLAIN_RECORDS, text);
}

/**
 * Strict: the header must be of `format`'s walk — one naming another is refused at line 1, both named — and every
 * body line a valid record, its block checked by the walk's schema. Explain's messages keep their words.
 */
export function decodeRecords<R extends WalkRecord, H extends StoreHeader>(format: RecordFormat<R, H>, text: string): InsightsFile<R, H> {
  refuseReader(format);
  const lines = nonEmptyLines(text);
  const first = lines[0];
  if (first === undefined) throw new InsightsFileError("empty insights file");
  let headerJson: unknown;
  try {
    headerJson = JSON.parse(first);
  } catch (error) {
    throw new InsightsFileError("line 1 is not JSON", { cause: error });
  }
  const found = storedWalkOf(headerJson);
  const mismatch = found === undefined ? undefined : walkMismatch(found, format);
  if (found !== undefined && mismatch !== undefined) {
    throw new InsightsFileError(`line 1 is the header ${mismatchPhrase(found, format, mismatch)}`);
  }
  const header = format.header.safeParse(headerJson);
  if (!header.success) {
    throw new InsightsFileError(`line 1 is not a ${format.kind} header: ${header.error.issues[0]?.message ?? "invalid"}`);
  }
  // A walk's block has fields of its own: its refusals say which. Explain's keep the words they always had.
  const withPath = format.kind !== EXPLAIN_RECORDS.kind;
  const records: R[] = [];
  const failures: FailureRecord[] = [];
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
    if (tag === "f") {
      const parsed = FailureRecord.safeParse(json);
      if (!parsed.success) {
        throw new InsightsFileError(`line ${i + 1}: invalid failure record: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
      failures.push(parsed.data);
      continue;
    }
    const parsed = format.record.safeParse(json);
    if (!parsed.success) {
      throw new InsightsFileError(`line ${i + 1}: invalid ${format.noun}: ${issueOf(parsed.error, withPath)}`);
    }
    records.push(parsed.data);
  }
  return {
    header: header.data,
    records,
    failures,
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
