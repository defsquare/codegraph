import { z } from "zod";

/**
 * The `history.jsonl` interchange records. One JSON object per line,
 * discriminated on `t`; section order `header → paths → commits → changes →
 * eof` is contractual and enforced by the reader (wire schemas cannot
 * describe a container).
 *
 * The M6 ideas, reused verbatim (PLAN §11.1): the one closed vocabulary
 * (authors) rides once in the header; the unbounded string set (paths) is
 * interned one record per line; every intra-file reference is a dense
 * surrogate int, file-scoped and never identity; the trailer counts what the
 * file carries so truncation is detectable.
 */

/** A reference into the path table. */
export const PathRef = z.int().min(0);
/** A reference into the commit section. */
export const CommitRef = z.int().min(0);
/** A reference into the header's author dictionary. */
export const AuthorRef = z.int().min(0);

export const HistoryHeaderRec = z
  .strictObject({
    t: z.literal("header"),
    /** Self-identification: a model file must be refusable as "not a history". */
    artifact: z.literal("history"),
    schemaVersion: z.int().min(1),
    scm: z.string().min(1),
    miner: z.string().min(1),
    repo: z.string(),
    dict: z.strictObject({
      authors: z.array(z.string().min(1)),
    }),
  })
  .describe("First record of a history.jsonl file.");
export type HistoryHeaderRec = z.infer<typeof HistoryHeaderRec>;

export const HistoryPathRec = z
  .strictObject({
    t: z.literal("f"),
    i: z.int().min(0),
    path: z.string().min(1),
  })
  .describe("One file lineage: the file's most recent path.");
export type HistoryPathRec = z.infer<typeof HistoryPathRec>;

export const HistoryCommitRec = z
  .strictObject({
    t: z.literal("c"),
    i: z.int().min(0),
    /** Full hash, lowercase hex. */
    h: z.string().regex(/^[0-9a-f]{40,64}$/),
    a: AuthorRef,
    /** Committer timestamp, unix seconds. */
    ts: z.int().min(0),
    /** Present only when true — the M6 habit of omitting absent values. */
    fix: z.literal(true).optional(),
    revert: z.literal(true).optional(),
  })
  .describe("One commit: metadata only, in (time, hash) order.");
export type HistoryCommitRec = z.infer<typeof HistoryCommitRec>;

export const HistoryChangeRec = z
  .strictObject({
    t: z.literal("x"),
    c: CommitRef,
    p: PathRef,
    /** Lines added / deleted; 0 for binary files. */
    a: z.int().min(0),
    d: z.int().min(0),
    /** The literal pre-rename path, when this change renamed the file. */
    from: z.string().min(1).optional(),
  })
  .describe("One file touched by one commit, path resolved to its lineage.");
export type HistoryChangeRec = z.infer<typeof HistoryChangeRec>;

export const HistoryEofRec = z
  .strictObject({
    t: z.literal("eof"),
    counts: z.strictObject({
      paths: z.int().min(0),
      commits: z.int().min(0),
      changes: z.int().min(0),
    }),
  })
  .describe("Trailer: the file is complete, and this is what it carries.");
export type HistoryEofRec = z.infer<typeof HistoryEofRec>;

export type HistoryRecord =
  | HistoryHeaderRec
  | HistoryPathRec
  | HistoryCommitRec
  | HistoryChangeRec
  | HistoryEofRec;
