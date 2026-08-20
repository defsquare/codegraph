import { Buffer } from "node:buffer";
import {
  buildGraph,
  foldGraph,
  foldedGraphToCsv,
  foldedGraphToJson,
  toDot,
  toJsonString,
  toPlantUml,
  type FoldedGraph,
  type LoadDiagnostics,
} from "@codegraph/analyzer";
import type { ExportOptions, FormatName } from "../args.js";
import type { ExitCode } from "../exit.js";
import { errLine, errLines, type IoSink } from "../io.js";
import { benignDuplicateIds, loadExitCode, loadModelFiles, type LoadedModels } from "../load.js";
import { resolveView } from "../view.js";

/**
 * `codegraph export <model.jsonl...> --format dot|json|csv`.
 *
 * Same pipeline as `analyze` up to the folded graph, then one renderer. Every
 * byte of the artifact comes from the analyzer's exporters — no escaping, no
 * ordering and no formatting is re-implemented here (decision 7).
 *
 * STREAM PURITY (decision 3) is the whole point of this command: with no
 * `--out`, stdout carries the artifact and NOTHING else — no banner, no timing,
 * no warning — so `codegraph export m.json --format dot > graph.dot` yields a
 * file a DOT parser accepts. Warnings, and the `--out` confirmation, are stderr.
 *
 * `--out FILE` goes through `io.writeFile`; the command never touches `fs`.
 * Two deliberate non-features there:
 *  - No overwrite guard. A "does it exist?" check followed by a write is a
 *    TOCTOU race that would promise a safety it cannot keep, so the file is
 *    written and the confirmation says where and how much.
 *  - No parent directories are created. A missing directory is a typo far more
 *    often than an intention, and `io.writeFile` already turns the failure into
 *    a usage error (exit 2) naming the path.
 *
 * Determinism (decision 6): the folded graph is already sorted and the
 * exporters sort what a `Set` would otherwise leave to insertion order, so the
 * same models and flags produce byte-identical output. Nothing is re-sorted or
 * re-ordered here.
 *
 * Exit: `EXIT.FINDINGS` when the load was not clean — the artifact is still
 * produced, because a bad model is exactly when a picture helps — else `EXIT.OK`.
 * `--format` itself is validated by the spec-driven parser (exit 2 naming the
 * valid formats) before this function is ever reached.
 */

/**
 * The JSON artefact is stamped by `foldedGraphToJson` — `kind`
 * `codegraph.foldedGraph/1`, `generatedBy`, and deliberately NO `schemaVersion`
 * — so it can never be mistaken for a model.jsonl. Passing the stamped object
 * through untouched is that guarantee's only requirement here.
 */
const RENDERERS: Readonly<Record<FormatName, (folded: FoldedGraph) => string>> = {
  dot: (folded) => toDot(folded),
  json: (folded) => toJsonString(foldedGraphToJson(folded)),
  csv: (folded) => foldedGraphToCsv(folded),
  plantuml: (folded) => toPlantUml(folded),
};

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}

/** What the artifact is, for the human stream only. */
function describe(folded: FoldedGraph, format: FormatName): string {
  return (
    `${format}, ${folded.level} level, view ${folded.view.name}, ` +
    `${plural(folded.nodes.length, "node")}, ${plural(folded.edges.length, "edge")}`
  );
}

/** The load's findings as counts; detail is `codegraph validate`'s job, not this one's. */
function findingCounts(diagnostics: LoadDiagnostics): readonly string[] {
  const parts: string[] = [];
  if (diagnostics.schemaErrors.length > 0) parts.push(plural(diagnostics.schemaErrors.length, "schema error"));
  if (diagnostics.profileIssues.length > 0) parts.push(plural(diagnostics.profileIssues.length, "profile issue"));
  if (diagnostics.danglingReferences.length > 0) {
    parts.push(plural(diagnostics.danglingReferences.length, "dangling reference"));
  }
  if (diagnostics.selfEdges.length > 0) parts.push(plural(diagnostics.selfEdges.length, "self-edge"));
  const conflicting = diagnostics.duplicateIds.filter((duplicate) => duplicate.conflicting).length;
  if (conflicting > 0) parts.push(plural(conflicting, "conflicting duplicate id"));
  return parts;
}

/**
 * Everything the user must know for the artifact to be trustworthy, on stderr.
 * A silently smaller graph is how a wrong number gets believed, so a fold that
 * dropped edges or could not place entities always says so.
 */
function warnings(loaded: LoadedModels, folded: FoldedGraph): readonly string[] {
  const lines: string[] = [];

  if (!loaded.clean) {
    const counts = findingCounts(loaded.diagnostics);
    lines.push(
      `warning: the models are not clean (${counts.join(", ")}); exported anyway.`,
      `Run 'codegraph validate ${loaded.paths.join(" ")}' for the detail.`,
    );
  }

  // Entities dedupe by id, edges do not: an overlapping union leaves every edge
  // weight in this artifact multiplied. Legal, so the exit code is unchanged —
  // but a doubled weight that says nothing about itself is a wrong number.
  const duplicates = benignDuplicateIds(loaded);
  if (duplicates > 0) {
    lines.push(
      `warning: ${plural(duplicates, "duplicate id", "duplicate ids")} — declared identically in ` +
        `more than one input model. Entities dedupe by id but edges do not, so the edge weights ` +
        `in this artifact are inflated by the overlap.`,
    );
  }

  const { droppedEdges, unfoldableEntities } = folded.diagnostics;
  if (droppedEdges > 0 || unfoldableEntities.length > 0) {
    lines.push(
      `warning: ${plural(droppedEdges, "base edge")} dropped and ` +
        `${plural(unfoldableEntities.length, "entity", "entities")} unplaceable at ` +
        `${folded.level} level — they have no container at that level in this view, ` +
        `so the exported graph is smaller than the model.`,
    );
  }

  return lines;
}

export function exportCommand(options: ExportOptions, io: IoSink): ExitCode {
  const loaded = loadModelFiles(options.models);
  const graph = buildGraph(loaded.union);
  const folded = foldGraph(graph, { level: options.level, view: resolveView(options) });
  const artifact = RENDERERS[options.format](folded);

  // Warnings before the artifact: on a terminal they are then visible ahead of
  // a large DOT, and being on stderr they cannot reach the artifact either way.
  errLines(io, warnings(loaded, folded));

  if (options.out === undefined) {
    io.out(artifact);
  } else {
    io.writeFile(options.out, artifact);
    // The confirmation is stderr even though nothing is on stdout: `--out`
    // must not become the one mode where stdout carries prose.
    errLine(
      io,
      `wrote ${plural(Buffer.byteLength(artifact, "utf8"), "byte")} to ${options.out} ` +
        `(${describe(folded, options.format)}).`,
    );
  }

  return loadExitCode(loaded);
}
