import { z } from "zod";
import { Edge } from "./edges.js";
import { Entity } from "./entity.js";

/** Version of the interchange contract carried by every model.json. */
export const SCHEMA_VERSION = "1.0.0";

/**
 * Provenance of the model itself. Loose on purpose: extractor-specific flags
 * (`noClasspath`, tool revisions…) must survive a parse round-trip untouched.
 */
export const ExtractorInfo = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type ExtractorInfo = z.infer<typeof ExtractorInfo>;

/**
 * Where the analyzed corpus lives in a hosted repository (METAMODEL.md §8a) —
 * FACTS, never a URL: the blob-URL template of a particular host is a
 * projection consumers derive (§9), and storing one would freeze one host's
 * scheme into the interchange.
 *
 * Each field is validated into the shape a projection can concatenate blindly:
 * an ssh remote, a `.git` suffix, a branch name where a sha belongs, or a root
 * that escapes the repository all produce links that 404, and a link that
 * quietly 404s is worse than no link at all.
 */
/**
 * Normalized https clone URL. Written as ONE regex rather than refinements
 * because `z.toJSONSchema()` drops refinements (the M1 audit's finding), and
 * `schemas/` is the contract an extractor in any language validates against:
 * `https://`, then anything but whitespace/query/fragment, not ending in
 * `.git` (the lookahead) and not in `/` (the final class).
 */
const HTTPS_REMOTE = /^https:\/\/(?![^\s]*\.git$)[^\s?#]*[^\s?#/]$/;

/**
 * A repo-relative path: `/`-joined segments, none of them empty, `.` or `..`
 * (the lookahead before each). The empty string — analyzed root IS the repo
 * root — is the other alternative.
 */
const RELATIVE_PATH = /^$|^(?!\.\.?(?:\/|$))[^/\s]+(?:\/(?!\.\.?(?:\/|$))[^/\s]+)*$/;

export const Repository = z.object({
  /** No ssh form, no `.git`, no trailing slash — see HTTPS_REMOTE. */
  remote: z.string().regex(HTTPS_REMOTE, "must be a normalized https URL (no ssh form, no .git)"),
  /** The sha extracted — a permalink. A branch name moves and is not a fact. */
  commit: z.string().regex(/^[0-9a-f]{7,64}$/, "must be a lowercase hex sha"),
  /**
   * The analyzed root RELATIVE to the repository root, `""` when they are the
   * same directory. Anchors are relative to the analyzed root, which may sit
   * below the repo root (gson: `gson/src/main/java`); without this prefix no
   * anchor projects back to a repository path.
   */
  root: z.string().regex(RELATIVE_PATH, "must be a path relative to the repository root"),
  /** Only when the hostname does not say (self-hosted); consumers guess otherwise. */
  provider: z.enum(["github", "gitlab"]).optional(),
});
export type Repository = z.infer<typeof Repository>;

/**
 * The interchange file (METAMODEL.md §8): one JSON document per extraction run.
 * Graph closure (every `from`/`to`/`parent`/`children` id resolving) is NOT
 * checked here — stubs are legitimate targets and closure is an analyzer-side
 * property over the union of models.
 */
export const Model = z.object({
  schemaVersion: z.string().min(1),
  lang: z.string().min(1),
  extractor: ExtractorInfo,
  root: z.string(),
  repository: Repository.optional(),
  entities: z.array(Entity),
  edges: z.array(Edge),
});
export type Model = z.infer<typeof Model>;

/** Parse a model.json payload, throwing a human-readable aggregate on failure. */
export function parseModel(input: unknown): Model {
  const result = Model.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid model.json:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
