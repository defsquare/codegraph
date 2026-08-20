import {
  checkConformance,
  compareIds,
  type ConformanceFinding,
  type ConformanceReport,
  type SchemaError,
} from "@codegraph/analyzer";
import type { ValidateOptions } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { benignDuplicateIds, loadModelFiles, type LoadedModels } from "../load.js";
import { outLines, type IoSink } from "../io.js";

/**
 * `codegraph validate <model.json...> [--json]` — THE ACCEPTANCE GATE.
 *
 * CLAUDE.md: "the property suite runs against every extractor output — it is
 * the acceptance gate for any new extractor." Someone writing a Go or .NET
 * extractor points this at their `model.json` and must be told precisely what
 * is wrong: which rule, which entity, which line of their file.
 *
 * The command computes nothing (M4 decision 7). It loads, calls the analyzer's
 * `checkConformance`, and formats. The rules themselves live in
 * `@codegraph/analyzer/conformance.ts` so the property suite and CI ask the
 * same question and get the same answer.
 *
 * STREAMS (decision 3): the report is the artifact, so it goes to stdout in
 * both modes — `codegraph validate m.json --json > report.json` must be a valid
 * JSON document. stderr stays empty; there is no progress worth printing for a
 * command whose whole output is the diagnosis.
 *
 * EXIT (decision 2): 0 when clean, 3 when the model has findings, 2 only for a
 * usage problem — which `loadModelFiles` raises as a `UsageError` and this
 * function deliberately does not catch.
 */
export function validateCommand(options: ValidateOptions, io: IoSink): ExitCode {
  const loaded = loadModelFiles(options.models);
  const report = checkConformance(loaded.union);

  outLines(io, options.json ? [renderJson(loaded, report)] : renderText(loaded, report));

  // A schema error means a file never became a model at all: `checkConformance`
  // never saw it, so the load's own verdict has to be folded in. Anything the
  // loader flagged but conformance did not is still a finding.
  return report.ok && loaded.clean ? EXIT.OK : EXIT.FINDINGS;
}

/** How many findings the text report lists before pointing at `--json`. */
const TEXT_FINDING_LIMIT = 25;

function renderText(loaded: LoadedModels, report: ConformanceReport): readonly string[] {
  const lines: string[] = [];
  const { subject, counts } = report;

  lines.push(
    `checked ${plural(subject.models, "model")} — ${plural(subject.entities, "entity", "entities")} ` +
      `(${subject.stubs} stub${subject.stubs === 1 ? "" : "s"}), ${plural(subject.edges, "edge")}` +
      (subject.langs.length > 0 ? `, lang ${subject.langs.join(", ")}` : ""),
  );
  for (const source of subject.sources) lines.push(`  ${source}`);

  // Re-declaring an id identically is legal (METAMODEL 1.1) and the conformance
  // `duplicate-id` rule rightly stays silent, so it is NOT a finding and does
  // not move the exit code. It still has to be SAID: the entity and edge totals
  // above count records, not distinct ids, so loading overlapping models
  // inflates them — and every folded edge weight downstream with them.
  const benign = benignDuplicateIds(loaded);
  if (benign > 0) {
    lines.push(
      `note: ${plural(benign, "duplicate id", "duplicate ids")} — declared in more than one model, ` +
        `identically, which is legal. The totals above count declarations, not distinct ids, ` +
        `so they are inflated by the overlap.`,
    );
  }

  // A file that is not a Model has no entities to report on; say so first, or
  // the counts above read as if it had been checked.
  if (loaded.diagnostics.schemaErrors.length > 0) {
    lines.push("");
    lines.push(`unreadable as a model (${loaded.diagnostics.schemaErrors.length}):`);
    for (const error of sortedSchemaErrors(loaded.diagnostics.schemaErrors)) {
      lines.push(`  ${error.label}:`);
      lines.push(...schemaErrorLines(error.message));
    }
  }

  if (report.findings.length > 0 || counts.errors + counts.warnings > 0) {
    lines.push("");
    lines.push("findings by code:");
    for (const code of Object.keys(counts.byCode).sort(compareIds)) {
      lines.push(`  ${pad(String(counts.byCode[code] ?? 0), 6)}${code}`);
    }

    lines.push("");
    const shown = report.findings.slice(0, TEXT_FINDING_LIMIT);
    lines.push(
      shown.length === report.findings.length
        ? `${plural(report.findings.length, "finding")}:`
        : `first ${shown.length} of ${plural(report.findings.length, "finding")}:`,
    );
    for (const finding of shown) lines.push(...findingLines(finding));
    if (shown.length < report.findings.length) {
      lines.push(`  ... ${report.findings.length - shown.length} more; run with --json for all of them`);
    }
    if (counts.suppressed > 0) {
      lines.push(`  ... ${counts.suppressed} further findings suppressed by the per-rule cap`);
    }
  }

  if (subject.unknownProfiles.length > 0) {
    lines.push("");
    lines.push(
      `not checked against a profile: ${subject.unknownProfiles.join(", ")} — ` +
        `core ships no profile for these langs, so only the structural rules ran.`,
    );
  }

  lines.push("");
  lines.push(verdict(loaded, report));
  return lines;
}

/**
 * Two lines per finding, because one long line is unreadable and an extractor
 * author needs both halves: WHERE it is written, and WHICH rule it broke.
 *
 *   error  closure/dangling-reference  fixtures/model.json edges[12].to
 *          edges[12].to points at "java:x/Y", which no entity in the corpus declares
 */
function findingLines(finding: ConformanceFinding): readonly string[] {
  return [
    `  ${pad(finding.severity, 8)}${finding.rule}/${finding.code}  ${finding.label} ${finding.path}`,
    `          ${finding.message}`,
  ];
}

function verdict(loaded: LoadedModels, report: ConformanceReport): string {
  const { errors, warnings } = report.counts;
  const schemaErrors = loaded.diagnostics.schemaErrors.length;

  if (report.ok && loaded.clean) {
    return warnings === 0
      ? "OK — every model conforms: closure, no self-reference, provenance, candidates, profile, anchors, ids."
      : `OK — every model conforms; ${plural(warnings, "warning")} did not fail the gate.`;
  }

  const parts: string[] = [];
  if (schemaErrors > 0) parts.push(`${plural(schemaErrors, "file")} that is not a model`);
  if (errors > 0) parts.push(plural(errors, "error"));
  if (warnings > 0) parts.push(plural(warnings, "warning"));
  // The loader can flag something conformance does not, and vice versa; say so
  // rather than reporting "0 errors" next to a non-zero exit code.
  if (parts.length === 0) parts.push("diagnostics from the loader");
  return `FAILED — ${parts.join(", ")}.`;
}

/**
 * `--json`: the SAME information, machine-readable (decision 8). The whole
 * report plus the loader's schema errors, which are the one class of problem
 * conformance cannot see because the file never became a model.
 */
function renderJson(loaded: LoadedModels, report: ConformanceReport): string {
  return JSON.stringify(
    {
      ok: report.ok && loaded.clean,
      subject: report.subject,
      counts: report.counts,
      findings: report.findings,
      schemaErrors: sortedSchemaErrors(loaded.diagnostics.schemaErrors),
      // Same fact as the text form's `note:` line — legal identical
      // re-declarations, which inflate `subject`'s declaration counts.
      duplicateIds: benignDuplicateIds(loaded),
    },
    null,
    2,
  );
}


/** Determinism (decision 6): label order, never the order the files happened to fail in. */
function sortedSchemaErrors(errors: readonly SchemaError[]): readonly SchemaError[] {
  return [...errors].sort((a, b) => compareIds(a.label, b.label) || a.modelIndex - b.modelIndex);
}

/**
 * Zod's aggregate message is a paragraph whose FIRST line is boilerplate
 * ("invalid model.json:") and whose remaining lines carry the only thing an
 * extractor author needs — which key, and what was wrong with it. Showing the
 * first line alone (as this did) reported a failure without its reason, so the
 * text form silently held less than `--json`, against decision 8. Bounded so a
 * catastrophically wrong file cannot bury the verdict; `--json` always has all.
 */
const TEXT_SCHEMA_DETAIL_LIMIT = 12;

function schemaErrorLines(message: string): readonly string[] {
  const all = message.split("\n").filter((line) => line.trim() !== "");
  let cut = Math.min(TEXT_SCHEMA_DETAIL_LIMIT, all.length);
  // Zod emits each issue as a "✖ <what>" line followed by its "→ at <path>"
  // line. Cutting between them would print a complaint with no location, which
  // is the failure this whole function exists to stop, so keep the pair whole.
  if (cut < all.length && all[cut - 1]?.startsWith("✖")) cut -= 1;
  const shown = all.slice(0, cut);
  const lines = shown.map((line) => `    ${line}`);
  if (all.length > shown.length) {
    lines.push(`    ... ${all.length - shown.length} more; run with --json for the whole message`);
  }
  return lines;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}

function plural(count: number, singular: string, plural_ = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural_}`;
}
