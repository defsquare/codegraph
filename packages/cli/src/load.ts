import { accessSync, constants } from "node:fs";
import { readModelFileSync, type Model } from "@codegraph/core";
import {
  isClean,
  loadDecodedModels,
  type LoadDiagnostics,
  type ModelUnion,
  type SchemaError,
} from "@codegraph/analyzer";
import { EXIT, UsageError, type ExitCode } from "./exit.js";

/**
 * "Read these paths, hand them to the analyzer, and put the failure in the
 * right bucket." The bucketing IS the contract (M4 decision 2):
 *
 *   unreadable path        -> UsageError, exit 2. The invocation is wrong; there
 *                             is nothing to analyze and nothing to report.
 *   malformed JSON /       -> a FINDING, exit 3. The tool worked; the file did
 *   payload that is not      not conform. It lands in `diagnostics.schemaErrors`
 *   a Model                  alongside everything else that is wrong with the
 *                            input, so one run reports on every file instead of
 *                            dying on the first bad one.
 *   valid Model that       -> a FINDING, exit 3, and the command STILL RUNS: the
 *   breaks its profile        user asked what is wrong, so show them.
 *
 * All validation is the analyzer's and core's; nothing is re-implemented here
 * (decision 7).
 */

export interface LoadedModels {
  /** Every model loaded, concatenated — ids are globally unique (decision 5). */
  readonly union: ModelUnion;
  /** Profile issues, dangling references, self-edges, duplicate ids, schema errors. */
  readonly diagnostics: LoadDiagnostics;
  /** The input paths in argument order, as typed — the labels in diagnostics. */
  readonly paths: readonly string[];
  /** The analyzer's `isClean(diagnostics)`, not a local re-derivation. */
  readonly clean: boolean;
}

/**
 * Reads one `.jsonl` model. Streaming, a line at a time: a model of a real
 * corpus does not fit in one JavaScript string, which is the whole reason the
 * interchange is line-based.
 *
 * The two failure classes stay exactly where M4 put them: an unreadable PATH is
 * a usage error (exit 2), while a readable file that is not a conforming model
 * is a FINDING (exit 3) reported alongside everything else wrong with the input.
 */
function readPayload(path: string, index: number): { payload: Model } | { error: SchemaError } {
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`cannot read ${path}: ${reason}`, "Check the path exists and is a readable file.", {
      cause: error,
    });
  }
  try {
    return { payload: readModelFileSync(path) };
  } catch (error) {
    // Not a usage error: the path was fine, the CONTENT is not a model.
    return {
      error: {
        modelIndex: index,
        label: path,
        message: `not a valid model.jsonl: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * Load every path as one union. Throws {@link UsageError} (exit 2) only when a
 * path cannot be read; everything else comes back as diagnostics so the caller
 * can report all of it at once.
 */
export function loadModelFiles(paths: readonly string[]): LoadedModels {
  const payloads: Model[] = [];
  const labels: string[] = [];
  const jsonErrors: SchemaError[] = [];

  paths.forEach((path, index) => {
    const result = readPayload(path, index);
    if ("error" in result) {
      jsonErrors.push(result.error);
      return;
    }
    payloads.push(result.payload);
    labels.push(path);
  });

  // `loadDecodedModels`, not `loadModels`: `readModelFileSync` already validated
  // every line against core's record schemas and enforced the container rules,
  // so re-running the whole Model through Zod is a second pass that can only
  // agree — 2.6 s of the 11.7 s a fineract command took. Everything that is NOT
  // redundant (profile validation, closure over the union, self-edges,
  // cross-model redeclaration) still runs; `load-equivalence.test.ts` pins that.
  const { union, diagnostics } = loadDecodedModels(payloads, { sources: labels });

  // `modelIndex` on a JSON error is the ARGUMENT position; on an analyzer error
  // it is the position among the payloads that parsed. Labels are the stable
  // identity in both cases, which is why every report keys on `label`.
  const merged: LoadDiagnostics =
    jsonErrors.length === 0
      ? diagnostics
      : { ...diagnostics, schemaErrors: [...jsonErrors, ...diagnostics.schemaErrors] };

  return { union, diagnostics: merged, paths, clean: isClean(merged) };
}

/** The exit code a load implies on its own: findings when anything is wrong. */
export function loadExitCode(loaded: LoadedModels): ExitCode {
  return loaded.clean ? EXIT.OK : EXIT.FINDINGS;
}

/**
 * Ids declared more than once across the union with IDENTICAL declarations.
 *
 * Legal (METAMODEL 1.1), so `isClean` stays true and no exit code moves — but
 * consequential, and therefore never silent. Entities dedupe by id while EDGES
 * DO NOT: loading overlapping models leaves every folded edge weight multiplied
 * by the overlap. A coupling number that is quietly double is exactly the kind
 * of wrong number decision 3's stderr exists to prevent, so every command that
 * counts something reports this.
 *
 * Conflicting duplicates are excluded: those are a real conformance finding and
 * are counted as one there.
 */
export function benignDuplicateIds(loaded: LoadedModels): number {
  return loaded.diagnostics.duplicateIds.filter((duplicate) => !duplicate.conflicting).length;
}
