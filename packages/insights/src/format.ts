import { z } from "zod";
import { digestOf } from "./fingerprint.js";
import {
  EXPLAIN_WALK_NAME,
  INSIGHTS_KIND,
  InsightRecord,
  InsightsHeader,
  LEVELS,
  STORED_BLOCK,
  WALK_RECORDS_KIND,
  WalkRecordsHeader,
  strictJsonSchema,
  walkRecordSchema,
  type Level,
  type StoreHeader,
  type WalkIdentity,
  type WalkRecord,
} from "./schema.js";
import type { AnswerBlock } from "./spec.js";

/**
 * RECORD FORMATS (PLAN.md §22.4): ONE STORE PER WALK. What a store and its
 * side-car are read and written with — the walk's name, what its header says of
 * it, and the schemas every line is checked by. A decoder or a store is HANDED
 * a format; it never guesses one from the file, it only checks that the file
 * agrees with it.
 *
 * WHICH WALK A FILE BELONGS TO is read from its header: `codegraph.insights/1`
 * is explain's (a header with no `walk` key — every store written before M21 —
 * included); `codegraph.walkRecords/1` names its walk in `walk.name`. A file of
 * another walk is refused as a foreign one is, bytes untouched — and so is a
 * file of the same name under other ANSWER fields (`answerDigest`): the
 * fingerprint hashes the answer schema, so every unit would be asked again
 * anyway, and a store keeping both shapes would export a side-car no
 * definition decodes. A changed definition of the same walk and answer (its
 * `digest`) is NOT refused — fingerprints decide what is redone — but
 * `walkChange` lets the caller say so first.
 */

export interface RecordFormat<R extends WalkRecord = WalkRecord, H extends StoreHeader = StoreHeader> {
  /** The walk's name: a store or a side-car of another name is refused. */
  readonly name: string;
  /** Its header's kind. */
  readonly kind: H["kind"];
  /**
   * What this walk's header says of it (`walk`); undefined: no key, the plain built-in explain. Its `answerDigest`, when
   * set, must be the file's too; a format naming none (explain's, a reader holding no definition) compares names only.
   */
  readonly walk: WalkIdentity | undefined;
  readonly header: z.ZodType<H>;
  /** A record line, written or decoded; re-parsing through it also fixes the key order the side-car is written in. */
  readonly record: z.ZodType<R>;
  /**
   * A record READ BACK from a store. Explain's is `record`; a walk's checks the envelope and keeps the block as it
   * was stored, so what an earlier definition of the walk bought (other fields) stays readable and exportable —
   * the store is not a cache. Only what is written now takes the current shape.
   */
  readonly stored: z.ZodType<R>;
  /** How a refused record line names what it should have been. */
  readonly noun: string;
  /**
   * A READER's format (`walkReader`): a store is opened with it read-only or not at all, and the codec refuses it —
   * what holds no definition has no schema to write by.
   */
  readonly readOnly?: boolean;
}

/** Explain's: the Specy blocks, `codegraph.insights/1`, no `walk` key. */
export const EXPLAIN_RECORDS: RecordFormat<InsightRecord, InsightsHeader> = Object.freeze({
  name: EXPLAIN_WALK_NAME,
  kind: INSIGHTS_KIND,
  walk: undefined,
  header: InsightsHeader,
  record: InsightRecord,
  stored: InsightRecord,
  noun: "insight record",
});

/** Explain's format under a customization's identity (`explainWalkIdentity`); none is plain explain's. */
export function explainRecords(walk: WalkIdentity | undefined): RecordFormat<InsightRecord, InsightsHeader> {
  if (walk === undefined) return EXPLAIN_RECORDS;
  if (walk.name !== EXPLAIN_WALK_NAME) throw new Error(`explain's records carry explain's name, not "${walk.name}"`);
  return Object.freeze({ ...EXPLAIN_RECORDS, walk: { name: walk.name, version: walk.version, digest: walk.digest } });
}

/** What a format needs of a compiled walk (`CompiledWalk` is one). */
export interface WalkOfRecords {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly answer: Readonly<Record<Level, z.ZodType<AnswerBlock>>>;
}

/**
 * sha256 of each level's block schema as it is SENT (strict JSON Schema), keys sorted: the shape of a walk's blocks
 * and nothing else — not a task, a label nor how a field was spelled.
 */
export function answerDigestOf(answer: Readonly<Record<Level, z.ZodType>>): string {
  return digestOf(Object.fromEntries(LEVELS.map((level) => [level, strictJsonSchema(answer[level])])));
}

/** A walk's record as read back from its store: the envelope, the block any object. */
const STORED_RECORD = walkRecordSchema({ operation: STORED_BLOCK, type: STORED_BLOCK, module: STORED_BLOCK });

/** A defined walk's: its compiled blocks, `codegraph.walkRecords/1`, its identity — answer digest included — in the header. */
export function walkRecords(walk: WalkOfRecords): RecordFormat<WalkRecord, WalkRecordsHeader> {
  if (walk.name === EXPLAIN_WALK_NAME) throw new Error("explain's records are EXPLAIN_RECORDS: its blocks are the Specy ones, not a definition's");
  return Object.freeze({
    name: walk.name,
    kind: WALK_RECORDS_KIND,
    walk: { name: walk.name, version: walk.version, digest: walk.digest, answerDigest: answerDigestOf(walk.answer) },
    header: WalkRecordsHeader,
    record: walkRecordSchema(walk.answer),
    stored: STORED_RECORD,
    noun: `record of the walk "${walk.name}"`,
  });
}

/** A reader's record schema: every line refused — written, encoded or decoded — for it knows no block's shape. */
const NO_WRITE = z.custom<WalkRecord>(() => false, { message: "a walk read without its definition writes no record" });

/**
 * A READER of the walk `name`'s store, holding no definition (`codegraph insights --walk N`, `serve --insights FILE`):
 * `walk` names no answer, so the store's walk NAME is compared and never its answer fields, and every record is read as
 * it was stored. It writes nothing: a store opens under it read-only or not at all, the codec refuses it, and its
 * record schema refuses every line. Explain's reader is explain's own format.
 */
export function walkReader(name: string): RecordFormat<WalkRecord, WalkRecordsHeader> {
  if (name === EXPLAIN_WALK_NAME) throw new Error("explain's store is read with EXPLAIN_RECORDS: its blocks are the Specy ones, not a definition's");
  return Object.freeze({
    name,
    kind: WALK_RECORDS_KIND,
    walk: undefined,
    header: WalkRecordsHeader,
    record: NO_WRITE,
    stored: STORED_RECORD,
    noun: `record of the walk "${name}"`,
    readOnly: true,
  });
}

/** Which walk a header says wrote it, read before any schema; `name` is undefined when the header names none. */
export interface StoredWalk {
  readonly kind: string;
  readonly name: string | undefined;
  /** A defined walk's answer digest, when its header carries one. */
  readonly answerDigest?: string | undefined;
}

/** Undefined for JSON that is no header of a walk's file at all (not an object, or a kind no walk writes). */
export function storedWalkOf(header: unknown): StoredWalk | undefined {
  if (header === null || typeof header !== "object") return undefined;
  const { kind, walk } = header as { kind?: unknown; walk?: unknown };
  if (kind === INSIGHTS_KIND) return { kind, name: EXPLAIN_WALK_NAME };
  if (kind !== WALK_RECORDS_KIND) return undefined;
  const { name, answerDigest } = walk !== null && typeof walk === "object" ? (walk as { name?: unknown; answerDigest?: unknown }) : {};
  return { kind, name: typeof name === "string" ? name : undefined, answerDigest: typeof answerDigest === "string" ? answerDigest : undefined };
}

/** `the walk "N" (kind)`: how every refusal names both sides. */
export function describeWalk(walk: { readonly kind: string; readonly name: string | undefined }): string {
  return walk.name === undefined ? `a walk's file that names no walk (${walk.kind})` : `the walk "${walk.name}" (${walk.kind})`;
}

/** Whether a header found belongs to `format`'s walk: same kind, same name. */
export function sameWalk(found: StoredWalk, format: Pick<RecordFormat, "name" | "kind">): boolean {
  return found.name !== undefined && found.kind === format.kind && found.name === format.name;
}

/** Why a file found is not `format`'s: another walk, or the same walk under other answer fields. */
export type WalkMismatch = "walk" | "answer";

/** Undefined when the file found is `format`'s; the answer is compared only when the format names one. */
export function walkMismatch(found: StoredWalk, format: Pick<RecordFormat, "name" | "kind" | "walk">): WalkMismatch | undefined {
  if (!sameWalk(found, format)) return "walk";
  const expected = format.walk?.answerDigest;
  return expected === undefined || found.answerDigest === expected ? undefined : "answer";
}

const ANSWER_CHANGED = "every unit would be asked again anyway, so a changed answer is another walk — under another name it keeps its own store";

/** How every refusal says what it found: `of the walk "A" (kind), not of the walk "B" (kind)`, or of the same under other answer fields. */
export function mismatchPhrase(found: StoredWalk, format: Pick<RecordFormat, "name" | "kind">, mismatch: WalkMismatch): string {
  return mismatch === "walk" ? `of ${describeWalk(found)}, not of ${describeWalk(format)}` : `of ${describeWalk(found)} under other answer fields: ${ANSWER_CHANGED}`;
}

/** A store's definition against the walk about to run on it: told before the count, never refused. */
export interface WalkChange {
  /** What the store's header says; undefined: a plain explain wrote it. */
  readonly previous: WalkIdentity | undefined;
  readonly current: WalkIdentity | undefined;
}

const sameIdentity = (a: WalkIdentity | undefined, b: WalkIdentity | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.name === b.name && a.version === b.version && a.digest === b.digest;

/**
 * The change a run is about to make to what its store was written under:
 * undefined when nothing changed, or when the store holds nothing (an empty
 * store has no definition). Reads the header it is given and nothing else; the
 * NAME never differs here — opening the store refused that already.
 */
export function walkChange(stored: StoreHeader | undefined, format: RecordFormat): WalkChange | undefined {
  if (stored === undefined) return undefined;
  const previous = stored.walk;
  return sameIdentity(previous, format.walk) ? undefined : { previous, current: format.walk };
}
