import type { z } from "zod";
import type { TypeDossier } from "@codegraph/analyzer";
import type { ContextPack, MemberPack } from "./context.js";
import type { JsonValue } from "./fingerprint.js";
import type { Prompt } from "./prompt.js";
import type { RecordSummary } from "./records.js";
import { cycleResponseSchema, type Level } from "./schema.js";
import type { OperationUnit, TemplateKind } from "./units.js";

/**
 * THE SEAM (PLAN.md §22.1): what a walk decides and the engine does not. The
 * engine — plan.ts, run.ts, context.ts, prompt.ts, records.ts, fingerprint.ts
 * — owns the units, their order, the user message's layout, the hashes and
 * the books; a spec owns the question asked of every unit and what is kept of
 * the answer. `explain` is one spec (explain-spec.ts). The engine reaches
 * nothing of a walk past this interface, and a boundary test holds it to that.
 *
 * A spec is REQUIRED wherever the engine needs one — carried in the context
 * env, so on every pack, and given to every book — never defaulted: an unwired
 * walk does not typecheck.
 */

/** A validated answer block. Opaque to the engine: only its spec reads a field of it. */
export type AnswerBlock = { readonly [field: string]: unknown };

/** What a quote is given of a record: its level and its block — or, for a spec that declares `quoted`, that projection of it. */
export interface QuotedRecord {
  readonly level: Level;
  readonly block: AnswerBlock;
}

export interface WalkSpec {
  /** The system message for a level and prompt shape; a cycle's (`scc`) asks one entry per member. */
  system(level: Level, shape: Prompt["shape"]): string;
  /** Lines closing a fully shown member's section, after every fact the engine lays out. */
  memberLines(member: MemberPack): readonly string[];
  /** The block a level answers, one per member; the engine wraps it for a cycle and derives the strict schema. */
  readonly answer: Readonly<Record<Level, z.ZodType>>;
  /** What is kept of a validated block, given the member its prompt showed (undefined if it showed none). */
  keep(block: AnswerBlock, member: MemberPack | undefined): AnswerBlock;
  /** What a dependent's prompt quotes of a record: its description and a short label. */
  quote(record: QuotedRecord): RecordSummary;
  /**
   * The block paths `quote` reads, dotted (`boundedContextHint.name`). Declared, `quote` is handed that PROJECTION
   * everywhere — in memory as from a store, which answers it in SQL without parsing the block (records.ts) — so it
   * must read nothing else. Absent, `quote` sees whole records, and one read back from a store is read whole.
   */
  readonly quoted?: readonly string[];
  /** Completion tokens one prompt is estimated to cost, for `blocks` members answered and what it asks. */
  completionTokens(level: Level, blocks: number, asked: Prompt["asked"]): number;
  /** The block of a trivial member (units.ts classifies), with no call. Absent: trivial members are asked. */
  readonly template?: (unit: OperationUnit, kind: TemplateKind, type: TypeDossier) => AnswerBlock;
  /**
   * The walk asks the words of names (PLAN.md §20.3): packs collect them through the env's speller and they
   * are hashed. `reads`: whether a unit's prompt shows a dependency's words — then it hashes that
   * dependency's fingerprint, else its chain. Absent: no word is collected, and none is read.
   */
  readonly words?: { readonly reads: (unit: Level, dependency: Level) => boolean };
  /**
   * What the fingerprint, the chain and the pre-split stamp hash beyond the engine's inputs. Absent, or undefined
   * for a unit: nothing — that unit's hashes keep their bytes (a customized explain touches only what it selects).
   */
  readonly fingerprint?: (pack: ContextPack) => JsonValue | undefined;
}

/** The schema a prompt's answer is validated against: the level's block, or a cycle's `members` of it. */
export function responseSchemaOf(spec: WalkSpec, level: Level, shape: Prompt["shape"]): z.ZodType {
  return shape === "block" ? spec.answer[level] : cycleResponseSchema(spec.answer[level]);
}
