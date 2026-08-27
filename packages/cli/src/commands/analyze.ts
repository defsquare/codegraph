import {
  comparePairs,
  compareIds,
  coupling,
  couplingToJson,
  cycles,
  cyclesToJson,
  foldedGraphToJson,
  sortIds,
  toJsonString,
  type CouplingRow,
  type CouplingTable,
  type CycleEdge,
  type CycleReport,
  type FoldDiagnostics,
  type FoldedEdge,
  type FoldedGraph,
  type FoldLevel,
  type ImportGraph,
  type ImportGraphDiagnostics,
  type StronglyConnectedComponent,
  type View,
  type ViewDescriptor,
} from "@codegraph/analyzer";
import { deriveFrameworkWiring, springProfile, type FrameworkWiring } from "@codegraph/analyzer";
import type { AnalyzeOptions, ReportName } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { errLine, errLines, outLines, type IoSink } from "../io.js";
import { benignDuplicateIds } from "../load.js";
import { openAnalysis, type AnalysisSource } from "../source.js";
import { resolveView } from "../view.js";

/**
 * `codegraph analyze <model.jsonl...> --report deps|cycles|coupling`.
 *
 * A SHELL over the analyzer (decision 7): it loads, picks the analyzer call the
 * report names, and formats. It computes no graph fact of its own — every
 * number printed here came out of `foldGraph`, `importGraph`,
 * `typeDependencyGraph`, `coupling` or `cycles` — and it never parses an
 * EntityId (CLAUDE.md invariant 7): ids are padded and compared as opaque
 * strings.
 *
 * Two rules the formatting exists to serve:
 *  - EVERY report states its level and its view on stdout. A coupling number
 *    without its view is not a fact, and the same fold under `--internal-only`
 *    answers a different question than the same fold without it.
 *  - An INFERENCE NEVER LOOKS LIKE A FACT. A dependency whose aggregated
 *    provenances are all `declared` is drawn `->`; one carrying `derived` or
 *    `dynamic-candidate` is drawn `~>` and names its provenances (CLAUDE.md
 *    invariant 2). On the java fixture the two module→`com.megacorp.ledger`
 *    import edges are derived, and they must not read as declared imports.
 */
export function analyzeCommand(options: AnalyzeOptions, io: IoSink): ExitCode {
  const source = openAnalysis(options.models, options, io);
  try {
    return analyzeSource(source, options, io);
  } finally {
    source.close();
  }
}

/**
 * Everything below the source. It reads `AnalysisSource` and never asks where
 * the answer came from: a store and a `.jsonl` produce the same `FoldedGraph`
 * (`store-fold.test.ts` pins that as an equality), so one formatting path
 * serves both and byte-identity is arithmetic rather than vigilance.
 */
function analyzeSource(source: AnalysisSource, options: AnalyzeOptions, io: IoSink): ExitCode {
  reportLoadHealth(source, io);

  const view = resolveView(options);
  const folded = foldFor(options.report, options.level, source, view);
  reportFoldHealth(folded, io);

  const context: ReportContext = {
    report: options.report,
    level: folded.level,
    view: folded.view,
    layer: layerOf(options.report, options.level),
    models: source.paths,
    modelClean: source.clean,
    foldDiagnostics: folded.diagnostics,
    top: options.top,
    json: options.json,
  };

  const exitCode = source.clean ? EXIT.OK : EXIT.FINDINGS;
  switch (options.report) {
    case "deps":
      return depsReport(folded, context, io, exitCode);
    case "coupling":
      return couplingReport(coupling(folded), context, io, exitCode);
    case "cycles":
      return cyclesReport(cycles(folded), context, io, exitCode);
    case "wiring":
      return wiringReport(
        deriveFrameworkWiring(source.graph(), springProfile),
        context,
        io,
        exitCode,
      );
  }
}

/* ------------------------------------------------------------------ wiring */

/**
 * What the CONTAINER does to the corpus (METAMODEL §9.1) — the roles the
 * framework assigns, and the implementations it could inject at each injection
 * point. Everything here is an INFERENCE over declared facts, and the report
 * says so in its header: no line of it is a fact about the code the way a
 * dependency is.
 */
function wiringReport(
  wiring: FrameworkWiring,
  context: ReportContext,
  io: IoSink,
  exitCode: ExitCode,
): ExitCode {
  if (context.json) {
    const ranking: Ranking = {
      by: "injection point id",
      top: null,
      shown: wiring.injectionPoints.length,
      total: wiring.injectionPoints.length,
      indices: [],
    };
    emitJson(io, {
      ...envelope(context, ranking),
      framework: wiring.framework,
      roles: wiring.roles,
      injectionPoints: wiring.injectionPoints,
      candidateEdges: wiring.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        provenance: edge.provenance,
        candidates: edge.candidates ?? [],
      })),
      wiringDiagnostics: wiring.diagnostics,
    });
    return exitCode;
  }

  const lines = [...headerLines(context)];
  lines.push(
    `framework: ${wiring.framework} — every line below is DERIVED from annotations,`,
    "           never a declared fact; candidate targets are `dynamic-candidate`.",
    "",
  );

  const stereotypes = new Map<string, string[]>();
  for (const role of wiring.roles) {
    if (role.role !== "stereotype" || role.stereotype === undefined) continue;
    const bucket = stereotypes.get(role.stereotype);
    if (bucket === undefined) stereotypes.set(role.stereotype, [role.id]);
    else bucket.push(role.id);
  }
  lines.push(`architectural roles (${countOf(stereotypes)} types):`);
  for (const [stereotype, ids] of [...stereotypes].sort(([a], [b]) => compareIds(a, b))) {
    lines.push(`  ${stereotype.padEnd(14)} ${ids.length}`);
    for (const id of sortIds(ids)) lines.push(`    ${id}`);
  }
  const entryPoints = wiring.roles.filter((role) => role.role === "entry-point");
  lines.push("", `entry points: ${entryPoints.length} (called from outside the corpus)`);

  lines.push("", `injection points: ${wiring.injectionPoints.length}`);
  for (const point of wiring.injectionPoints) {
    const via = point.via === "annotation" ? "annotated" : "sole ctor";
    lines.push(`  ${point.id}  [${via}]`);
    lines.push(`    wants ${point.declaredType ?? "(unresolved)"}`);
    if (point.candidates.length === 0) {
      lines.push(`    ~> none — ${point.note ?? "no corpus implementation"}`);
    } else {
      for (const candidate of point.candidates) lines.push(`    ~> ${candidate}`);
      if (point.note !== undefined) lines.push(`       (${point.note})`);
    }
  }

  lines.push(
    "",
    `derived ${wiring.edges.length} candidate edge(s); ` +
      `${wiring.diagnostics.unimplemented} injection point(s) have no corpus implementation, ` +
      `${wiring.diagnostics.narrowed} narrowed by @Primary/@Qualifier, ` +
      `${wiring.diagnostics.unresolvedTypes} with an unresolved type.`,
  );
  outLines(io, lines);
  return exitCode;
}

function countOf(groups: ReadonlyMap<string, readonly string[]>): number {
  let total = 0;
  for (const ids of groups.values()) total += ids.length;
  return total;
}

/* ------------------------------------------------------------------ context */

interface ReportContext {
  readonly report: ReportName;
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  readonly layer: string;
  readonly models: readonly string[];
  readonly modelClean: boolean;
  readonly foldDiagnostics: FoldDiagnostics;
  readonly top: number | undefined;
  readonly json: boolean;
}

/**
 * Which analyzer query answers this report.
 *
 * `deps` is the DEPENDENCY LAYER of the chosen level, and the two levels have
 * different first-class layers: at module level that is the import graph — the
 * only layer comparable across every language (CLAUDE.md invariant 9) — and at
 * type level the type-dependency graph, which folds every edge kind. `coupling`
 * and `cycles` are metrics over the WHOLE fold at that level, because a package
 * that never imports another but calls into it is still coupled to it.
 *
 * The consequence is visible on the java fixture and is stated in every header:
 * `deps --level module` reports 6 import edges while `coupling --level module`
 * measures the 14-edge full module fold. Both are true; the `layer:` line says
 * which one was asked for.
 */
function foldFor(
  report: ReportName,
  level: FoldLevel,
  source: AnalysisSource,
  view: View,
): FoldedGraph {
  if (report !== "deps") return source.fold({ level, view });
  return level === "module" ? source.imports(view) : source.typeDependencies(view);
}

function layerOf(report: ReportName, level: FoldLevel): string {
  // The wiring report reads the BASE graph, not a fold: annotations sit on
  // members, and folding them away is exactly what would lose them.
  if (report === "wiring") return "annotation uses over the base graph (not folded)";
  if (report !== "deps") return `every edge kind folded to ${level} level`;
  return level === "module"
    ? "import edges only, module -> module (the cross-language layer)"
    : "every edge kind folded to type level";
}

function isImportGraph(folded: FoldedGraph): folded is ImportGraph {
  return "importDiagnostics" in folded;
}

/* ------------------------------------------------------------- stderr notes */

/**
 * A model with findings still gets analyzed — the user asked a question and
 * refusing to answer helps nobody — but the numbers may be affected, and saying
 * so belongs on stderr so the artifact on stdout stays the artifact.
 */
function reportLoadHealth(loaded: AnalysisSource, io: IoSink): void {
  // Reported even on a CLEAN load: identical re-declaration across models is
  // legal, but entities dedupe by id while edges do not, so every weight,
  // fan-in and fan-out below is multiplied by the overlap. A silently doubled
  // coupling number is precisely what this stream exists to prevent.
  const duplicates = benignDuplicateIds(loaded);
  if (duplicates > 0) {
    errLine(
      io,
      `warning: ${duplicates} duplicate ids — declared identically in more than one input model. ` +
        `Entities dedupe by id but edges do not, so the counts below are inflated by the overlap.`,
    );
  }

  if (loaded.clean) return;
  const d = loaded.diagnostics;
  errLines(io, [
    "warning: the models loaded with findings — the numbers below may be affected.",
    `  schema errors ${d.schemaErrors.length} · profile issues ${d.profileIssues.length} · ` +
      `dangling references ${d.danglingReferences.length} · self edges ${d.selfEdges.length} · ` +
      `duplicate ids ${d.duplicateIds.length} · unknown profiles ${d.unknownProfiles.length}`,
    "  Run `codegraph validate` on the same paths for the detail.",
  ]);
}

/**
 * Folding drops the edges whose endpoints have no container at this level (5 at
 * module level and 10 at type level on the java fixture). A silently smaller
 * graph is how a wrong number gets trusted, so this prints on every run.
 */
function reportFoldHealth(folded: FoldedGraph, io: IoSink): void {
  const d = folded.diagnostics;
  errLine(
    io,
    `fold(${folded.level}): ${d.foldedEdges} base edges aggregated into ${folded.edges.length}; ` +
      `${d.droppedEdges} dropped (an endpoint has no ${folded.level} container in this view); ` +
      `${d.unfoldableEntities.length} entities unplaceable.`,
  );
  if (!isImportGraph(folded)) return;
  const imports = folded.importDiagnostics;
  errLine(io, `import layer: ${imports.importEdges} base import edges kept by this view.`);
  if (imports.nonModuleEndpoints.length === 0) return;
  // A real extraction signal, not noise: the extractor wrote the import layer
  // below module granularity.
  errLines(io, [
    `warning: ${imports.nonModuleEndpoints.length} import endpoints do not carry TModule and were folded onto one.`,
    ...imports.nonModuleEndpoints
      .slice(0, 10)
      .map((e) => `  ${e.role} of ${e.edgeFrom} -> ${e.edgeTo}: ${e.endpoint} => ${e.foldedTo ?? "(no module)"}`),
  ]);
}

/* ------------------------------------------------------------------ ranking */

interface Ranking {
  /** What the order means, printed verbatim in the text form. */
  readonly by: string;
  readonly top: number | null;
  readonly shown: number;
  readonly total: number;
  /** Positions into the source array, in rank order, already limited. */
  readonly indices: readonly number[];
}

function rank<T>(items: readonly T[], by: string, score: (a: T, b: T) => number, top: number | undefined): Ranking {
  const indices = items.map((_item, index) => index);
  indices.sort((a, b) => {
    const left = items[a];
    const right = items[b];
    if (left === undefined || right === undefined) return a - b;
    return score(left, right);
  });
  const limited = top === undefined ? indices : indices.slice(0, top);
  return { by, top: top ?? null, shown: limited.length, total: items.length, indices: limited };
}

function pick<T>(items: readonly T[], ranking: Ranking): readonly T[] {
  const out: T[] = [];
  for (const index of ranking.indices) {
    const item = items[index];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/** "12 of 71 rows, ranked by …" — a truncated table that reads as complete is a lie. */
function rankingLine(ranking: Ranking, noun: string): string {
  const count =
    ranking.shown === ranking.total
      ? `${ranking.total} ${noun}`
      : `${ranking.shown} of ${ranking.total} ${noun} (--top ${ranking.top ?? 0})`;
  // Naming an order over an empty list says nothing and reads as a mistake.
  return ranking.total === 0 ? count : `${count}, ranked by ${ranking.by}`;
}

/* ------------------------------------------------------------- shared text */

function viewLabel(view: ViewDescriptor): string {
  return view.filters.length === 0
    ? `${view.name} (nothing filtered — stubs and inferred edges included)`
    : `${view.name} (${view.filters.join(", ")})`;
}

/** The header IS part of the artifact: a number without its view is not a fact. */
function headerLines(context: ReportContext): readonly string[] {
  return [
    `codegraph analyze — ${context.report}`,
    `models: ${context.models.join(", ")}`,
    `level:  ${context.level}`,
    `view:   ${viewLabel(context.view)}`,
    `layer:  ${context.layer}`,
    "",
  ];
}

function maxLength(values: Iterable<string>): number {
  let max = 0;
  for (const value of values) if (value.length > max) max = value.length;
  return max;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * `push(...lines)` spreads one argument per element, and a real corpus produces
 * tens of thousands of them — enough to exceed the argument limit and crash a
 * report that had already been computed correctly.
 */
function pushAll(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}

const PROVENANCE_LEGEND =
  "legend: '->' a declared fact · '~>' carries a derived or dynamic-candidate inference";

const FEEDBACK_LEGEND =
  "legend: '[feedback]' — minimum feedback set: cutting these edges leaves the graph acyclic";

/** Tangle metrics read as percentages (Structure101's convention), one decimal. */
function percent(metric: number): string {
  return `${(metric * 100).toFixed(1)}%`;
}

function allDeclared(provenances: Iterable<string>): boolean {
  const sorted = sortIds([...provenances]);
  return sorted.length === 1 && sorted[0] === "declared";
}

function provenanceOf(provenances: Iterable<string>): string {
  return sortIds([...provenances]).join("+");
}

/** One aggregated dependency, drawn so an inference cannot pass for a fact. */
function edgeLine(
  from: string,
  to: string,
  count: number,
  kinds: Iterable<string>,
  provenances: Iterable<string>,
  selfLoop: boolean,
  fromWidth: number,
  toWidth: number,
  feedback = false,
): string {
  const arrow = allDeclared(provenances) ? "->" : "~>";
  const self = selfLoop ? "  (self)" : "";
  const cut = feedback ? "  [feedback]" : "";
  return (
    `  ${padRight(from, fromWidth)} ${arrow} ${padRight(to, toWidth)}` +
    `  weight=${count}  kinds=${sortIds([...kinds]).join(",")}` +
    `  provenance=${provenanceOf(provenances)}${self}${cut}`
  );
}

function foldedEdgeLines(edges: readonly FoldedEdge[]): readonly string[] {
  const fromWidth = maxLength(edges.map((edge) => edge.from));
  const toWidth = maxLength(edges.map((edge) => edge.to));
  return edges.map((edge) =>
    edgeLine(edge.from, edge.to, edge.count, edge.kinds, edge.provenances, edge.selfLoop, fromWidth, toWidth),
  );
}

function cycleEdgeLines(
  edges: readonly CycleEdge[],
  indent: string,
  // Membership by REFERENCE: feedbackArcSet returns the same objects that sit
  // in `component.edges`, so a Set of them needs no key encoding.
  feedback: ReadonlySet<CycleEdge>,
): readonly string[] {
  const fromWidth = maxLength(edges.map((edge) => edge.from));
  const toWidth = maxLength(edges.map((edge) => edge.to));
  return edges.map(
    (edge) =>
      indent +
      edgeLine(
        edge.from,
        edge.to,
        edge.count,
        edge.kinds,
        edge.provenances,
        edge.selfLoop,
        fromWidth,
        toWidth,
        feedback.has(edge),
      ),
  );
}

/** The envelope every `--json` payload shares — the header, machine-readable. */
interface AnalyzeEnvelope {
  readonly kind: string;
  readonly report: ReportName;
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  readonly layer: string;
  readonly models: readonly string[];
  readonly modelClean: boolean;
  readonly foldDiagnostics: {
    readonly unfoldableEntities: readonly string[];
    readonly droppedEdges: number;
    readonly foldedEdges: number;
  };
  readonly ranking: { readonly by: string; readonly top: number | null; readonly shown: number; readonly total: number };
}

/** Analysis output, not a model: no `schemaVersion`, and it says what it is. */
const ANALYZE_ARTEFACT_KIND = "codegraph.analyze/1";

function envelope(context: ReportContext, ranking: Ranking): AnalyzeEnvelope {
  return {
    kind: ANALYZE_ARTEFACT_KIND,
    report: context.report,
    level: context.level,
    view: { name: context.view.name, filters: [...context.view.filters] },
    layer: context.layer,
    models: [...context.models],
    modelClean: context.modelClean,
    foldDiagnostics: {
      unfoldableEntities: [...context.foldDiagnostics.unfoldableEntities],
      droppedEdges: context.foldDiagnostics.droppedEdges,
      foldedEdges: context.foldDiagnostics.foldedEdges,
    },
    ranking: { by: ranking.by, top: ranking.top, shown: ranking.shown, total: ranking.total },
  };
}

function emitJson(io: IoSink, payload: unknown): void {
  io.out(toJsonString(payload));
}

/* --------------------------------------------------------------- deps report */

/**
 * Weight first: a folded edge's `count` is how many base edges hold the
 * dependency together, i.e. what it would cost to cut. Ties break on
 * `comparePairs` over the endpoints, the analyzer's own edge-table order, so
 * two runs never disagree.
 */
function rankDependencies(edges: readonly FoldedEdge[], top: number | undefined): Ranking {
  return rank(
    edges,
    "weight descending (base edges aggregated), ties by (from, to)",
    (a, b) => b.count - a.count || comparePairs([a.from, a.to], [b.from, b.to]),
    top,
  );
}

function depsReport(
  folded: FoldedGraph,
  context: ReportContext,
  io: IoSink,
  loadCode: ExitCode,
): ExitCode {
  const ranking = rankDependencies(folded.edges, context.top);
  const shown = pick(folded.edges, ranking);

  if (context.json) {
    const json = foldedGraphToJson(folded);
    emitJson(io, {
      ...envelope(context, ranking),
      nodeCount: folded.nodes.length,
      edgeCount: folded.edges.length,
      nodes: json.nodes,
      // The same limiting as the text form: `--json` changes how a result is
      // printed, never what it says (decision 8).
      edges: pick(json.edges, ranking),
      ...(isImportGraph(folded) ? { importDiagnostics: importJson(folded.importDiagnostics) } : {}),
    });
    return loadCode;
  }

  const limited = ranking.shown !== ranking.total;

  // `--top N` means "the N heaviest dependencies AND their context". Listing every
  // node anyway buries the answer: on a 3 600-entity corpus at type level, --top 10
  // put the ten requested rows at line 289 under 280 lines of inventory. When the
  // dependency list is limited, the node list narrows to the nodes those
  // dependencies touch — and says how many it left out, so it never reads complete.
  const participating = new Set<string>();
  for (const edge of shown) {
    participating.add(edge.from);
    participating.add(edge.to);
  }
  const nodesShown = limited
    ? folded.nodes.filter((node) => participating.has(node.id))
    : folded.nodes;

  const lines = [...headerLines(context)];
  lines.push(`nodes: ${folded.nodes.length}`);
  lines.push(`edges: ${rankingLine(ranking, "aggregated dependencies")}`);
  if (limited) {
    lines.push(
      `        (--top limits the dependency list; the node list narrows to the ${nodesShown.length} nodes those dependencies touch)`,
    );
  }
  lines.push("");

  lines.push("nodes");
  if (nodesShown.length === 0) {
    lines.push("  (none — nothing folds to this level under this view)");
  } else {
    const idWidth = maxLength(nodesShown.map((node) => node.id));
    const kindWidth = maxLength(nodesShown.map((node) => node.kind));
    for (const node of nodesShown) {
      const external = node.isStub ? "  external (stub)" : "";
      lines.push(
        `  ${padRight(node.id, idWidth)}  ${padRight(node.kind, kindWidth)}  members=${node.members}${external}`,
      );
    }
    if (limited) {
      lines.push(
        `  … ${folded.nodes.length - nodesShown.length} other nodes not shown (--top); drop --top for the full inventory.`,
      );
    }
  }
  lines.push("");

  lines.push("dependencies");
  if (shown.length === 0) {
    lines.push(`  none — no dependency survives ${context.view.name} at ${context.level} level.`);
  } else {
    lines.push(`  ${PROVENANCE_LEGEND}`);
    pushAll(lines, foldedEdgeLines(shown));
    if (ranking.shown !== ranking.total) {
      lines.push(`  … ${ranking.total - ranking.shown} lower-weight dependencies not shown.`);
    }
  }

  outLines(io, lines);
  return loadCode;
}

function importJson(diagnostics: ImportGraphDiagnostics): {
  readonly importEdges: number;
  readonly nonModuleEndpoints: readonly ImportGraphDiagnostics["nonModuleEndpoints"][number][];
} {
  return {
    importEdges: diagnostics.importEdges,
    nonModuleEndpoints: [...diagnostics.nonModuleEndpoints],
  };
}

/* ----------------------------------------------------------- coupling report */

/**
 * TOTAL COUPLING DEGREE (Ca + Ce) descending, then Ca descending, then id.
 *
 * Chosen because `--top N` promises "the N most-coupled", and a node's coupling
 * is how many distinct nodes it is tied to in EITHER direction — ranking by Ce
 * alone hides the load-bearing type nothing can change, ranking by Ca alone
 * hides the god class. Ca breaks the tie so that between two equally-coupled
 * nodes the more depended-upon one — the riskier one to touch — comes first,
 * and the id breaks the rest so the table is byte-identical across runs
 * (decision 6).
 */
function rankCoupling(rows: readonly CouplingRow[], top: number | undefined): Ranking {
  return rank(
    rows,
    "total coupling Ca+Ce descending, ties by Ca then id",
    (a, b) => b.ca + b.ce - (a.ca + a.ce) || b.ca - a.ca || compareIds(a.id, b.id),
    top,
  );
}

const COUPLING_COLUMNS = ["FAN-IN", "FAN-OUT", "CA", "CE", "I"] as const;

function couplingReport(
  table: CouplingTable,
  context: ReportContext,
  io: IoSink,
  loadCode: ExitCode,
): ExitCode {
  const ranking = rankCoupling(table.rows, context.top);
  const shown = pick(table.rows, ranking);

  if (context.json) {
    const json = couplingToJson(table);
    emitJson(io, { ...envelope(context, ranking), rows: pick(json.rows, ranking) });
    return loadCode;
  }

  const lines = [...headerLines(context)];
  lines.push(`coupling: ${rankingLine(ranking, "nodes")}`);
  lines.push("  Ca = afferent (distinct nodes depending on this one) = fan-in");
  lines.push("  Ce = efferent (distinct nodes this one depends on)   = fan-out");
  lines.push("  I  = Ce / (Ca + Ce); 0 when nothing touches the node. Self-loops excluded.");
  lines.push("");

  if (shown.length === 0) {
    lines.push(`no node survives ${context.view.name} at ${context.level} level.`);
    outLines(io, lines);
    return loadCode;
  }

  const labels = shown.map((row) => (row.isStub ? `${row.id} (external)` : row.id));
  const idWidth = Math.max(maxLength(labels), "NODE".length);
  const cells = shown.map((row) => [
    String(row.fanIn),
    String(row.fanOut),
    String(row.ca),
    String(row.ce),
    row.instability.toFixed(3),
  ]);
  const widths = COUPLING_COLUMNS.map((column, index) =>
    Math.max(column.length, maxLength(cells.map((cell) => cell[index] ?? ""))),
  );

  const header = COUPLING_COLUMNS.map((column, index) => padLeft(column, widths[index] ?? 0)).join("  ");
  lines.push(`  ${padRight("NODE", idWidth)}  ${header}`);
  shown.forEach((_row, position) => {
    const rendered = (cells[position] ?? []).map((cell, index) => padLeft(cell, widths[index] ?? 0)).join("  ");
    lines.push(`  ${padRight(labels[position] ?? "", idWidth)}  ${rendered}`);
  });

  if (ranking.shown !== ranking.total) {
    lines.push("");
    lines.push(`  … ${ranking.total - ranking.shown} less-coupled nodes not shown (--top ${ranking.top ?? 0}).`);
  }

  outLines(io, lines);
  return loadCode;
}

/* ------------------------------------------------------------- cycles report */

/** Biggest tangle first: size, then the weight it would cost to cut, then id. */
function rankCycles(
  components: readonly StronglyConnectedComponent[],
  top: number | undefined,
): Ranking {
  return rank(
    components,
    "component size descending, ties by weight then first member",
    (a, b) => b.size - a.size || b.weight - a.weight || compareIds(a.members[0] ?? "", b.members[0] ?? ""),
    top,
  );
}

function cyclesReport(
  report: CycleReport,
  context: ReportContext,
  io: IoSink,
  loadCode: ExitCode,
): ExitCode {
  const ranking = rankCycles(report.components, context.top);
  const shown = pick(report.components, ranking);
  // `--top` caps the self-loop list at the same N so one flag means one budget.
  const selfLoops =
    context.top === undefined ? report.selfLoops : report.selfLoops.slice(0, context.top);

  // A cycle is a finding ABOUT THE MODEL (exit 3), not a failure of the tool
  // (exit 1): the analysis succeeded. Self-loops alone are not — at type level a
  // folding self-loop is a method calling a sibling, which is cohesion.
  const found = report.components.length > 0;
  if (found) {
    errLine(
      io,
      `${report.components.length} dependency cycle(s) at ${context.level} level under view ` +
        `${context.view.name} — exiting ${EXIT.FINDINGS} (findings).`,
    );
  }
  const code: ExitCode = found ? EXIT.FINDINGS : loadCode;

  if (context.json) {
    const json = cyclesToJson(report);
    emitJson(io, {
      ...envelope(context, ranking),
      componentCount: report.components.length,
      selfLoopCount: report.selfLoops.length,
      // The roll-up is from the FULL report: a --top-limited artifact must
      // still state the whole tangle, or a capped view would understate it.
      tangle: json.tangle,
      components: pick(json.components, ranking),
      selfLoops: [...selfLoops],
    });
    return code;
  }

  const lines = [...headerLines(context)];
  lines.push(`cycles: ${rankingLine(ranking, "strongly connected components")}`);
  if (found) {
    lines.push(
      `tangle: ${percent(report.tangle.metric)} overall — feedback weight ${report.tangle.feedbackWeight}` +
        ` of ${report.tangle.cyclicWeight} cyclic references (minimum feedback set)`,
    );
  }
  lines.push(`self-dependencies after folding: ${report.selfLoops.length}`);
  lines.push("");

  if (report.components.length === 0) {
    // "No cycles" is a RESULT. Printing nothing here would leave the reader
    // unable to tell success from a command that silently did no work.
    lines.push(`no dependency cycle at ${context.level} level under view ${context.view.name}.`);
    lines.push("");
  } else {
    lines.push(`  ${PROVENANCE_LEGEND}`);
    lines.push(`  ${FEEDBACK_LEGEND}`);
    lines.push("");
    shown.forEach((component, position) => {
      lines.push(
        `cycle ${position + 1} — ${component.size} nodes, ${component.internalEdgeCount} edges,` +
          ` weight ${component.weight}, tangle ${percent(component.tangleMetric)}`,
      );
      lines.push("  members:");
      for (const member of component.members) lines.push(`    ${member}`);
      lines.push("  edges:");
      pushAll(lines, cycleEdgeLines(component.edges, "  ", new Set(component.feedbackEdges)));
      lines.push("");
    });
    if (ranking.shown !== ranking.total) {
      lines.push(`… ${ranking.total - ranking.shown} smaller cycles not shown (--top ${ranking.top ?? 0}).`);
      lines.push("");
    }
  }

  lines.push("self-dependencies after folding");
  if (report.selfLoops.length === 0) {
    lines.push("  none.");
  } else {
    lines.push(`  a node whose own members depend on each other — cohesion at ${context.level} level, not a cycle:`);
    for (const id of selfLoops) lines.push(`    ${id}`);
    if (selfLoops.length !== report.selfLoops.length) {
      lines.push(`    … ${report.selfLoops.length - selfLoops.length} more not shown (--top ${context.top ?? 0}).`);
    }
  }

  outLines(io, lines);
  return code;
}
