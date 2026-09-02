import { createHash } from "node:crypto";
import { PROMPT_VERSION, type Level } from "./schema.js";

/**
 * WHAT A RECORD IS A FUNCTION OF. The fingerprint is a sha256 over every input
 * the explanation was computed from — the source slices, the comments, the
 * signature, a digest of the model facts, the prompt version, the model slug
 * — plus the fingerprints of the units it depended on. Merkle-style: change a
 * leaf's source and exactly its transitive dependents and containers change
 * fingerprint; nothing else does.
 *
 * DELIBERATELY EXCLUDED: the explanation text itself. Two runs of the same
 * prompt can return different words, and if those words fed the fingerprint a
 * single non-deterministic answer would cascade re-runs up the whole graph.
 */

export interface FingerprintInputs {
  readonly level: Level;
  /** The unit's members, sorted. */
  readonly members: readonly string[];
  readonly model: string;
  /** Per member, in member order: the source text the prompt will show. */
  readonly sources: readonly string[];
  readonly comments: readonly string[];
  readonly signatures: readonly string[];
  /** A digest of the facts shown (calls, accesses, throws, fields, imports…). */
  readonly factsDigest: string;
  /** Fingerprints of the units this one depends on, sorted. */
  readonly dependencyFingerprints: readonly string[];
  /** Dependencies that had NO record when this unit was explained, sorted — once one exists, redo. */
  readonly missingDependencies: readonly string[];
  /** The context depth: a deeper prompt is a different prompt. */
  readonly depth: number;
}

/** JSON with object keys sorted at every level, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function fingerprintOf(inputs: FingerprintInputs): string {
  return digestOf({ promptVersion: PROMPT_VERSION, ...inputs });
}
