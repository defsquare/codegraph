import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { type CodeGraph, type ViewDescriptor } from "@codegraph/analyzer";
import {
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  buildVocabulary,
  operationScope,
  parseBusinessTerms,
  parseTechnicalWords,
  vocabularyCloudSvg,
  vocabularyDrift,
  vocabularyToJsonString,
  type BusinessTerms,
  type DriftReport,
  type OperationScope,
  type ScopeLevel,
  type VocabularyArtifact,
  type VocabularyOptions as CountOptions,
  type VocabularyScope,
  type Weights,
} from "@codegraph/vocabulary";
import type { VocabularyOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, errLines, outLines, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { resolveView, viewLabel } from "../view.js";

/**
 * `codegraph vocabulary <model.jsonl...>`: the words the model's names are
 * made of (PLAN.md §20.1).
 *
 * A SHELL over `@codegraph/vocabulary`, like `analyze` over the analyzer:
 * every count printed here is the artifact's, or an operation's counted by
 * the package on demand. This command picks the scope, the class and the
 * report, and writes the artifact on `--out` and the cloud on `--svg` beside
 * the report.
 *
 * The header IS part of the report: a count without its view, its weights and
 * its technical list is not a fact, so all three are stated on stdout.
 *
 * `--drift` exits 3 when a business term is said by no scope of the level,
 * as `analyze --report cycles` does when a cycle exists: the tool worked, and
 * the answer is bad news a CI job may gate on.
 */
export function vocabularyCommand(options: VocabularyOptions, io: IoSink): ExitCode {
  // The flag files first: a bad one must fail before the model is read.
  const technical = options.technical === undefined ? undefined : technicalOf(options.technical);
  const glossary = options.drift === undefined ? undefined : glossaryOf(options.drift);
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const source = openAnalysis(options.models, options, io);
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const counting: CountOptions = { view, weights, ...(technical === undefined ? {} : { technical: technical.words }) };
    const artifact = buildVocabulary(graph, counting);
    errLines(io, vocabularyWarnings(source, artifact));

    const header: Header = {
      models: source.paths,
      view: artifact.view,
      weights: artifact.weights,
      technical: artifact.technical,
      technicalFile: options.technical,
    };
    let code: ExitCode = source.clean ? EXIT.OK : EXIT.FINDINGS;
    if (glossary !== undefined) {
      const report = vocabularyDrift(artifact, glossary.terms, { level: options.level });
      errLines(
        io,
        glossary.wordless.map(({ line, text }) => `warning: line ${line} of ${glossary.path} names no word, skipped: ${text}`),
      );
      outLines(io, driftReport(artifact, report, header, options, glossary));
      const unsaid = report.business.filter((term) => term.scopes.length === 0).length;
      if (unsaid > 0) {
        errLine(io, `${plural(unsaid, "business term")} ${neverSays(report.level)} — exiting 3 (findings).`);
        code = EXIT.FINDINGS;
      }
    } else {
      const scopes =
        options.scope === undefined
          ? scopesAt(artifact, options.level)
          : [scopeOf(graph, artifact, options.scope, counting)];
      const top = options.top ?? (options.scope === undefined && options.level !== "corpus" ? 10 : 40);
      outLines(io, wordsReport(artifact, scopes, header, options, top));
      // The parser let --svg through with one scope only: the corpus, or --scope's.
      const [one] = scopes;
      if (options.svg !== undefined && one !== undefined) writeCloud(io, options.svg, artifact, one, options.termClass, top);
    }

    if (options.out !== undefined) {
      const text = vocabularyToJsonString(artifact);
      io.writeFile(options.out, text);
      errLine(
        io,
        `wrote ${plural(Buffer.byteLength(text, "utf8"), "byte")} to ${options.out} ` +
          `(vocabulary, view ${artifact.view.name}, ${plural(artifact.terms.length, "term")}, ` +
          `${plural(artifact.scopes.length, "scope")}).`,
      );
    }
    return code;
  } finally {
    source.close();
  }
}

/* ------------------------------------------------------------- flag files */

function readText(path: string, flag: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      `${flag} takes a plain text file, one entry per line.`,
      { cause: error },
    );
  }
}

function technicalOf(path: string): { readonly words: readonly string[] } {
  const parsed = parseTechnicalWords(readText(path, "--technical"));
  if (parsed.invalid.length > 0) {
    throw new UsageError(
      `${plural(parsed.invalid.length, "line")} of ${path} ${parsed.invalid.length === 1 ? "is" : "are"} not one word`,
      [
        ...parsed.invalid.slice(0, 10).map(({ line, text }) => `  line ${line}: ${text}`),
        "A technical entry is one word, as the splitter yields it: `dto`, not `HTTPServer` or `value object`.",
      ].join("\n"),
    );
  }
  return parsed;
}

/** A glossary and the path it was read from, which the report names. */
interface Glossary extends BusinessTerms {
  readonly path: string;
}

function glossaryOf(path: string): Glossary {
  const parsed = parseBusinessTerms(readText(path, "--drift"));
  if (parsed.terms.length === 0) {
    throw new UsageError(
      `${path} holds no business term`,
      "--drift takes one business term per line: Order Line, Customer, …",
    );
  }
  return { path, ...parsed };
}

/* ------------------------------------------------------------- the scopes */

/** A stored scope, or an operation's: what a block prints. */
type AnyScope = VocabularyScope | OperationScope;

/** The level's scopes, by distinct terms descending, ties by artifact order (which is id order). */
function scopesAt(artifact: VocabularyArtifact, level: ScopeLevel): readonly AnyScope[] {
  return artifact.scopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => scope.level === level)
    .sort((a, b) => b.scope.distinct - a.scope.distinct || a.index - b.index)
    .map(({ scope }) => scope);
}

/**
 * `--scope ID`: a stored module or type, else an operation counted on demand.
 * Anything else is a usage error that says what the id IS — an unknown id is
 * a typo, a stub speaks no words, a member's words are its scope's.
 */
function scopeOf(
  graph: CodeGraph,
  artifact: VocabularyArtifact,
  id: string,
  counting: CountOptions,
): AnyScope {
  const stored = artifact.scopes.find((scope) => scope.id === id);
  if (stored !== undefined) return stored;
  const entity = graph.entity(id);
  if (entity === undefined) {
    throw new UsageError(
      `unknown scope '${id}'`,
      "Pass a module, type or operation id as the model writes it (`codegraph navigator` and `analyze` print them).",
    );
  }
  if (graph.isStub(id)) {
    throw new UsageError(`${id} is external (a stub): its name was chosen elsewhere, so it speaks no words`);
  }
  const operation = operationScope(graph, artifact, id, counting);
  if (operation !== undefined) return operation;
  throw new UsageError(
    `${id} is a ${entity.kind}, not a module, type or operation`,
    `Its words are counted in ${aroundOf(graph, artifact, id)}.`,
  );
}

/** The nearest stored scope up the containment chain, by id; the corpus when there is none. */
function aroundOf(graph: CodeGraph, artifact: VocabularyArtifact, id: string): string {
  const ids = new Set(artifact.scopes.map((scope) => scope.id));
  const seen = new Set<string>([id]);
  for (let cursor = graph.parentOf(id); cursor !== undefined && !seen.has(cursor); cursor = graph.parentOf(cursor)) {
    if (ids.has(cursor)) return cursor;
    seen.add(cursor);
  }
  return `the corpus ${artifact.corpus.name}`;
}

/* ------------------------------------------------------------- the header */

/** Both reports' `--json` kind; `report` says which. */
const REPORT_KIND = "codegraph.vocabularyReport/1";

interface Header {
  readonly models: readonly string[];
  readonly view: ViewDescriptor;
  readonly weights: Weights;
  readonly technical: VocabularyArtifact["technical"];
  readonly technicalFile: string | undefined;
}

function headerLines(report: "words" | "drift", header: Header, where: string): readonly string[] {
  const list = header.technicalFile === undefined ? "" : ` from ${header.technicalFile}`;
  return [
    `codegraph vocabulary — ${report}`,
    `models:    ${header.models.join(", ")}`,
    where,
    `view:      ${viewLabel(header.view)}`,
    `weights:   ${WEIGHT_KEYS.map((key) => `${key} ${header.weights[key]}`).join(" · ")}`,
    `technical: ${plural(header.technical.words, "shared word")}${list} ` +
      `(sha256 ${header.technical.sha256.slice(0, 12)}) + each language's own`,
  ];
}

/* ------------------------------------------------------------ words report */

const WORD_COLUMNS = ["WEIGHT", "OCC", "CARRIERS", "MODULES", "TYPES"] as const;

function wordsReport(
  artifact: VocabularyArtifact,
  scopes: readonly AnyScope[],
  header: Header,
  options: VocabularyOptions,
  top: number,
): readonly string[] {
  if (options.json) {
    return [
      JSON.stringify({
        kind: REPORT_KIND,
        report: "words",
        models: header.models,
        level: options.scope === undefined ? options.level : (scopes[0]?.level ?? options.level),
        scope: options.scope ?? null,
        view: header.view,
        weights: header.weights,
        technical: header.technical,
        class: options.termClass,
        top,
        scopes: scopes.map((scope) => scopeJson(artifact, scope, options.termClass, top)),
      }),
    ];
  }

  const where = options.scope === undefined ? `level:     ${options.level}` : `scope:     ${options.scope}`;
  const lines = [...headerLines("words", header, where), ""];
  if (options.scope === undefined && options.level !== "corpus") {
    lines.push(`${plural(scopes.length, options.level)}, ranked by distinct terms descending, ties by id`, "");
  }
  for (const scope of scopes) {
    lines.push(...scopeBlock(artifact, scope, options.termClass, top), "");
  }
  lines.pop();
  return lines;
}

function scopeTitle(artifact: VocabularyArtifact, scope: AnyScope): string {
  if (scope.level === "corpus") return `corpus ${scope.name}`;
  const what = `${scope.level} ${scope.id ?? ""} (${scope.kind ?? ""} ${scope.name})`;
  if (scope.level !== "operation") return what;
  const around = artifact.scopes[scope.parent];
  return `${what}, counted on demand, inside ${around?.id ?? `the corpus ${artifact.corpus.name}`}`;
}

function scopeBlock(
  artifact: VocabularyArtifact,
  scope: AnyScope,
  termClass: VocabularyOptions["termClass"],
  top: number,
): readonly string[] {
  const spoke = Object.entries(scope.roles).filter(([, count]) => count > 0);
  const speakers = spoke.reduce((sum, [, count]) => sum + count, 0);
  const skipped = [
    ...(scope.skipped.unnamed > 0 ? [`${scope.skipped.unnamed} unnamed`] : []),
    ...(scope.skipped.conventional > 0 ? [`${scope.skipped.conventional} conventional`] : []),
    ...(scope.skipped.numeric > 0 ? [`${plural(scope.skipped.numeric, "numeric piece")} dropped`] : []),
  ];
  const roles = spoke.length === 0 ? "" : ` (${spoke.map(([role, count]) => `${role} ${count}`).join(" · ")})`;
  const lines = [
    scopeTitle(artifact, scope),
    `  ${plural(scope.entities, "entity", "entities")}: ${speakers} ${speakers === 1 ? "speaks" : "speak"}${roles}` +
      (skipped.length === 0 ? "" : `, ${skipped.join(", ")}`),
    `  ${plural(scope.distinct, "distinct term")}, ${scope.distinctDomain} domain · weight ${scope.weight} · ` +
      plural(scope.occurrences, "occurrence"),
  ];

  const { rows, total } = rowsOfClass(artifact, scope, termClass, top);
  const what = termClass === "all" ? "all classes" : termClass;
  if (total === 0) {
    lines.push(`  ${what}: no term`);
    return lines;
  }
  const count = rows.length === total ? plural(total, "term") : `${rows.length} of ${total} terms (--top ${top})`;
  lines.push(`  ${what}: ${count}, by weight descending, ties by term`, "");

  const cells = rows.map((row) => [
    row.text,
    row.class,
    ...[row.weight, row.occurrences, row.carriers, row.modules, row.types].map(String),
  ]);
  lines.push(...table(["TERM", "CLASS", ...WORD_COLUMNS], cells, 2));
  return lines;
}

interface WordRow {
  readonly text: string;
  readonly class: string;
  readonly weight: number;
  readonly occurrences: number;
  readonly carriers: number;
  readonly modules: number;
  readonly types: number;
}

function rowsOfClass(
  artifact: VocabularyArtifact,
  scope: AnyScope,
  termClass: VocabularyOptions["termClass"],
  top: number,
): { readonly rows: readonly WordRow[]; readonly total: number } {
  const matching = scope.terms.filter(([term]) => termClass === "all" || artifact.terms[term]?.class === termClass);
  const rows = matching.slice(0, top).map(([term, weight, occurrences, carriers]): WordRow => {
    const entry = artifact.terms[term];
    return {
      text: entry?.text ?? "",
      class: entry?.class ?? "",
      weight,
      occurrences,
      carriers,
      modules: entry?.modules ?? 0,
      types: entry?.types ?? 0,
    };
  });
  return { rows, total: matching.length };
}

function scopeJson(
  artifact: VocabularyArtifact,
  scope: AnyScope,
  termClass: VocabularyOptions["termClass"],
  top: number,
): unknown {
  const { rows, total } = rowsOfClass(artifact, scope, termClass, top);
  const { terms: _terms, parent, ...counts } = scope;
  const around = parent === undefined ? undefined : (artifact.scopes[parent]?.id ?? null);
  return { ...counts, ...(around === undefined ? {} : { parent: around }), shown: rows.length, total, terms: rows };
}

function writeCloud(
  io: IoSink,
  path: string,
  artifact: VocabularyArtifact,
  scope: AnyScope,
  termClass: VocabularyOptions["termClass"],
  top: number,
): void {
  const svg = vocabularyCloudSvg(artifact, scope, { termClass, top });
  io.writeFile(path, svg);
  const { rows, total } = rowsOfClass(artifact, scope, termClass, top);
  const what = termClass === "all" ? "" : `${termClass} `;
  const count = rows.length === total ? plural(total, `${what}term`) : `${rows.length} of ${total} ${what}terms`;
  const label = scope.level === "corpus" ? `corpus ${scope.name}` : `${scope.level} ${scope.name}`;
  errLine(io, `wrote ${plural(Buffer.byteLength(svg, "utf8"), "byte")} to ${path} (cloud of ${label}: ${count}).`);
}

/* ------------------------------------------------------------ drift report */

function neverSays(level: ScopeLevel): string {
  return level === "corpus" ? "the corpus never says" : `no ${level} says`;
}

function driftReport(
  artifact: VocabularyArtifact,
  report: DriftReport,
  header: Header,
  options: VocabularyOptions,
  glossary: Glossary,
): readonly string[] {
  const top = options.top ?? 40;
  const shown = report.codeOnly.slice(0, top);
  const idOf = (index: number): string => artifact.scopes[index]?.id ?? "";

  if (options.json) {
    return [
      JSON.stringify({
        kind: REPORT_KIND,
        report: "drift",
        models: header.models,
        level: report.level,
        view: header.view,
        weights: header.weights,
        technical: header.technical,
        glossary: { path: glossary.path, terms: glossary.terms.length, wordless: glossary.wordless },
        business: report.business.map(({ text, words, scopes, missing }) => ({
          text,
          words,
          said: scopes.length > 0,
          ...(report.level === "corpus" ? {} : { scopes: scopes.map(idOf) }),
          missing,
        })),
        codeOnly: {
          shown: shown.length,
          total: report.codeOnly.length,
          top,
          words: shown.map(({ term, weight, occurrences, scopes }) => ({
            text: artifact.terms[term]?.text ?? "",
            weight,
            occurrences,
            scopes,
          })),
        },
      }),
    ];
  }

  const lines = [
    ...headerLines("drift", header, `level:     ${report.level}`),
    `glossary:  ${glossary.path}, ${plural(glossary.terms.length, "business term")}`,
    "",
  ];
  const total = report.business.length;
  const unsaid = report.business.filter((term) => term.scopes.length === 0);
  const said = report.business.filter((term) => term.scopes.length > 0);
  const width = Math.max(...report.business.map((term) => term.text.length));

  if (unsaid.length === 0) lines.push(`never said: none of ${plural(total, "business term")}`);
  else {
    const why = report.level === "corpus" ? "a word the corpus never says" : `no ${report.level} says all their words`;
    lines.push(`never said: ${unsaid.length} of ${plural(total, "business term")}, ${why}`);
    for (const term of unsaid) {
      const reason =
        term.missing.length > 0 ? `missing ${term.missing.join(", ")}` : `every word is said, never in one ${report.level}`;
      lines.push(`  ${pad(term.text, width)}  ${reason}`);
    }
  }
  lines.push("", `said: ${said.length} of ${plural(total, "business term")}`);
  for (const term of said) {
    if (report.level === "corpus") lines.push(`  ${term.text}`);
    else {
      const where =
        term.scopes.length === 1 ? `1 ${report.level}: ${idOf(term.scopes[0] ?? 0)}` : plural(term.scopes.length, report.level);
      lines.push(`  ${pad(term.text, width)}  ${where}`);
    }
  }

  const count = shown.length === report.codeOnly.length ? `${shown.length}` : `${shown.length} of ${report.codeOnly.length}`;
  const cut = shown.length === report.codeOnly.length ? "" : ` (--top ${top})`;
  lines.push("", `code only: ${count} domain words no business term contains${cut}, by weight descending, ties by term`);
  if (shown.length > 0) {
    const perLevel = report.level === "corpus" ? [] : [`${report.level.toUpperCase()}S`];
    const cells = shown.map(({ term, weight, occurrences, scopes }) => [
      artifact.terms[term]?.text ?? "",
      String(weight),
      String(occurrences),
      ...(report.level === "corpus" ? [] : [String(scopes)]),
    ]);
    lines.push("", ...table(["TERM", "WEIGHT", "OCC", ...perLevel], cells, 1));
  }
  return lines;
}

/* ---------------------------------------------------------------- shared */

/** A left-aligned text column (the first `left` ones), the numbers right-aligned. */
function table(columns: readonly string[], cells: readonly (readonly string[])[], left: number): readonly string[] {
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((row) => (row[i] ?? "").length)));
  const line = (row: readonly string[]): string =>
    `  ${row
      .map((cell, i) => (i < left ? pad(cell, widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ")
      .trimEnd()}`;
  return [line(columns), ...cells.map(line)];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function plural(count: number, noun: string, plural_ = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural_}`;
}

/**
 * What makes the counts smaller or vaguer than the model, on stderr: an
 * unclean load, a language split with no lexicon, entities no module holds.
 */
export function vocabularyWarnings(
  source: { readonly clean: boolean; readonly paths: readonly string[] },
  artifact: VocabularyArtifact,
): readonly string[] {
  const lines: string[] = [];
  if (!source.clean) {
    lines.push(
      "warning: the models are not clean; the vocabulary was counted anyway.",
      `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`,
    );
  }
  for (const lang of artifact.diagnostics.withoutLexicon) {
    lines.push(
      `note: no lexicon for ${lang}: its names are split by the universal rules alone, ` +
        "no keyword or conventional name known.",
    );
  }
  const unplaced = artifact.diagnostics.unplaced.length;
  if (unplaced > 0) {
    lines.push(`note: ${plural(unplaced, "entity", "entities")} in no module: counted in the corpus alone.`);
  }
  return lines;
}
