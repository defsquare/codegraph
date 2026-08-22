import { statSync } from "node:fs";
import { JsonlError } from "@codegraph/core";
import {
  diagnoseStore,
  importModel,
  isClean,
  openStore,
  storePathFor,
  type ImportResult,
  type LoadDiagnostics,
} from "@codegraph/analyzer";
import type { ImportOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";

/**
 * `codegraph import <model.jsonl...> [--out FILE] [--json]`.
 *
 * Builds the analysis store. `model.db` is a DERIVED, DISPOSABLE cache of one
 * `.jsonl` — regenerable at any time, never committed, never the interchange
 * (docs/model-encoding.md §1). Importing is therefore always unconditional:
 * the user asked for a store, so they get a fresh one, and nothing here tries
 * to be clever about whether the old one was still good. That question belongs
 * to the automatic cache, which has to answer it without being asked.
 *
 * ONE MODEL PER STORE. Every other command unions its positional models;
 * this one deliberately does not. Surrogates are file-scoped and are not
 * identity (MM-1), so a union would mean renumbering — and a renumbered corpus
 * is a repointed one. Several paths just mean several imports.
 *
 * STREAMS (decision 3). stdout carries what is TRUE of the store: where it is,
 * and what it holds. stderr carries what was true of the RUN: how long it took
 * and how big the file came out. That split is not cosmetic — SQLite makes no
 * byte-determinism promise (page allocation varies), and a duration never
 * could, so neither may appear on the stream `e2e-determinism` compares.
 *
 * EXIT (decision 2). 0 when the model conforms, 3 when it does not — the import
 * still succeeded and the store is still there, exactly as `analyze` completes
 * and still reports. Saying nothing would leave a user analyzing a corpus with
 * known findings and no hint of it. Step 8 is what makes this affordable:
 * `diagnoseStore` answers by query, ~0.5s on a 241 101-entity corpus.
 */
export function importCommand(options: ImportOptions, io: IoSink): ExitCode {
  const results: StoreSummary[] = [];
  const refused: { source: string; message: string }[] = [];

  for (const model of options.models) {
    const started = performance.now();
    let result: ImportResult;
    try {
      result = importOne(model, options.out);
    } catch (error) {
      // A readable file that is not a model is a FINDING, not a crash — the
      // record reader refusing it says something about the MODEL. Collected
      // rather than thrown so one run reports on every path, the same choice
      // `loadModelFiles` makes for the reading commands.
      if (!(error instanceof JsonlError)) throw error;
      refused.push({ source: model, message: error.message });
      continue;
    }
    const elapsedMs = performance.now() - started;

    const store = openStore(result.path);
    let diagnostics: LoadDiagnostics;
    try {
      diagnostics = diagnoseStore(store, { label: model, modelIndex: 0 });
      results.push({ ...describe(store, model, result), diagnostics });
    } finally {
      store.close();
    }

    // The run, not the store: never on stdout. See the note above.
    errLine(
      io,
      `${model}: ${(elapsedMs / 1000).toFixed(2)} s, ` +
        `${megabytes(statSync(model).size)} jsonl -> ${megabytes(result.bytes)} db`,
    );
    reportFindings(diagnostics, model, io);
  }

  outLines(io, options.json ? [renderJson(results, refused)] : renderText(results, refused));
  const clean = refused.length === 0 && results.every((one) => isClean(one.diagnostics));
  return clean ? EXIT.OK : EXIT.FINDINGS;
}

/** What the store holds, read back out of it. */
interface StoreSummary {
  readonly source: string;
  readonly store: string;
  readonly lang: string;
  readonly entities: number;
  readonly stubs: number;
  readonly edges: number;
  readonly files: number;
  readonly diagnostics: LoadDiagnostics;
}

function importOne(model: string, out: string | undefined): ImportResult {
  try {
    return importModel(model, out ?? storePathFor(model));
  } catch (error) {
    // An unreadable or unwritable PATH is a usage error (exit 2); a readable
    // file that is not a model is not — that is the record reader refusing it,
    // and it belongs to the model, not the invocation.
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR" || code === "ENOTDIR") {
      throw new UsageError(
        `cannot import ${model}: ${error instanceof Error ? error.message : String(error)}`,
        "Check the model path exists and the target directory is writable.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Counts straight from the store — the numbers a later `analyze` will see. */
function describe(
  store: ReturnType<typeof openStore>,
  source: string,
  result: ImportResult,
): Omit<StoreSummary, "diagnostics"> {
  const scalar = (sql: string): number => Number(Object.values(store.prepare(sql).get() ?? {})[0] ?? 0);
  const lang = store.prepare("SELECT value FROM meta WHERE key = 'lang'").get();
  return {
    source,
    store: result.path,
    lang: (lang?.value as string | undefined) ?? "",
    entities: result.counts.entities,
    stubs: scalar("SELECT count(*) AS n FROM entity WHERE is_stub = 1"),
    edges: result.counts.edges,
    files: result.counts.files,
  };
}

function renderText(
  results: readonly StoreSummary[],
  refused: readonly { source: string; message: string }[],
): readonly string[] {
  const lines: string[] = [];
  for (const one of results) {
    lines.push(`imported ${one.source} -> ${one.store}`);
    lines.push(
      `  ${plural(one.entities, "entity", "entities")} (${one.stubs} stub${one.stubs === 1 ? "" : "s"}), ` +
        `${plural(one.edges, "edge")}, ${plural(one.files, "file")}` +
        (one.lang === "" ? "" : `, lang ${one.lang}`),
    );
  }
  if (refused.length > 0) {
    lines.push("");
    lines.push(`not a model, so no store was written (${refused.length}):`);
    for (const one of refused) {
      lines.push(`  ${one.source}:`);
      for (const line of one.message.split("\n")) lines.push(`    ${line}`);
    }
  }

  lines.push("");
  if (refused.length > 0) {
    lines.push("Nothing was imported for the files above. `codegraph validate` says the same, in detail.");
  } else if (results.every((one) => isClean(one.diagnostics))) {
    lines.push("OK — the store is ready. Run `codegraph analyze` against the model as usual.");
  } else {
    lines.push("The store is ready, but the model has findings. Run `codegraph validate` for the detail.");
  }
  return lines;
}

function renderJson(
  results: readonly StoreSummary[],
  refused: readonly { source: string; message: string }[],
): string {
  return JSON.stringify(
    {
      ok: refused.length === 0 && results.every((one) => isClean(one.diagnostics)),
      refused,
      stores: results.map((one) => ({
        source: one.source,
        store: one.store,
        lang: one.lang,
        counts: {
          entities: one.entities,
          stubs: one.stubs,
          edges: one.edges,
          files: one.files,
        },
        findings: {
          profileIssues: one.diagnostics.profileIssues.length,
          byCode: one.diagnostics.profileIssueCounts,
          selfEdges: one.diagnostics.selfEdges.length,
          duplicateIds: one.diagnostics.duplicateIds.length,
          unknownProfiles: one.diagnostics.unknownProfiles,
        },
      })),
    },
    null,
    2,
  );
}

/** The same shape `analyze` uses: say the numbers may be affected, once. */
function reportFindings(diagnostics: LoadDiagnostics, model: string, io: IoSink): void {
  if (isClean(diagnostics)) return;
  const d = diagnostics;
  errLine(
    io,
    `warning: ${model} has findings — profile issues ${d.profileIssues.length} · ` +
      `self edges ${d.selfEdges.length} · duplicate ids ${d.duplicateIds.length} · ` +
      `unknown profiles ${d.unknownProfiles.length}. ` +
      "Run `codegraph validate` on the model for the detail.",
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
