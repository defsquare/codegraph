import type { EntityId } from "@codegraph/core";
import type { FoldedEdge, FoldedGraph, FoldedNode, FoldLevel } from "../fold.js";
import { sortIds } from "../order.js";

/**
 * Stage 7: the PlantUML rendering of a folded graph — one element per folded
 * node, one dependency arrow per aggregated edge.
 *
 * THE ELEMENT FOLLOWS THE FOLD LEVEL, because the node's nature does:
 *
 *   module level   `package`   every node carries TModule; it IS a package, and
 *                              drawing it as a class would assert a type that
 *                              the model never declared
 *   type level     `class`     every node carries TType
 *
 * So a module-level diagram contains no `class` statement at all: the boxes are
 * PlantUML packages, and the only nodes are the model's modules — which is what
 * the fold already selected (it walks TChildOf to the nearest TModule ancestor
 * and never parses an id).
 *
 * A rendering is a claim about the model, so CLAUDE.md's honesty rule governs
 * it. Every visual channel maps to one documented fact and nothing else:
 *
 *   solid arrow  `-->`   the aggregated base edges are ALL provenance `declared`
 *   dashed arrow `..>`   at least one aggregated base edge is an inference
 *                        (`derived` / `dynamic-candidate` / `generated`)
 *   arrow label          FoldedEdge.count — the number of base edges aggregated
 *   <<kind>> stereotype  FoldedNode.kind, verbatim from the model — omitted when
 *                        it would only repeat the element (`package <<package>>`)
 *   <<stub>> stereotype  FoldedNode.isStub — external, not corpus-declared
 *   title                the fold level and the view — a diagram without its
 *                        view is not a fact, and comments do not render
 *
 * IDENTITY LIVES IN THE ALIAS, NOT THE LABEL. PlantUML needs a word-shaped
 * alias per class, but ids are opaque strings (CLAUDE.md invariant 7), so each
 * id is sanitized and then made unique with a numeric suffix, assigned in the
 * folded graph's own sorted order. The mapping is injective by construction:
 * two ids that sanitize identically get DIFFERENT aliases rather than being
 * silently merged into one class with edges the model never related.
 *
 * Deterministic: nodes and edges are emitted in the folded graph's sorted
 * order and aliases depend only on that order, so two runs are byte-identical.
 */

export interface PlantUmlOptions {
  /** Node label source. Defaults to `name` with a fallback to the id. */
  readonly labels?: "name" | "id";
  /** Emit the view/level/diagnostics as leading `'` comments. Defaults to true. */
  readonly header?: boolean;
  /** Emit the encoding legend block. Defaults to true. */
  readonly legend?: boolean;
}

/**
 * Escape an arbitrary string for use inside a PlantUML quoted class name,
 * using PlantUML's own `<U+XXXX>` unicode escape.
 *
 * Correctness, not cosmetics. Four characters can corrupt the statement or the
 * render: `"` closes the quoted name; a raw newline (or any control character)
 * splits the statement across physical lines; `\` arms PlantUML escape
 * sequences such as `\n`; and `<` opens a creole tag, so a name containing
 * `<b>` would silently render BOLD instead of showing the name.
 *
 * The mapping is INJECTIVE: `<` itself is escaped, so every literal `<U+` in
 * the output was introduced here and a label that already contains the text
 * `<U+0022>` can never collide with an escaped quote.
 */
export function escapePlantUmlLabel(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/["<\\\u0000-\u001f\u007f]/g, (character) =>
    `<U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** Comment text can never introduce a new line and so escape the comment. */
function escapeComment(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function isDeclaredOnly(edge: FoldedEdge): boolean {
  return edge.provenances.size === 1 && edge.provenances.has("declared");
}

function labelFor(node: FoldedNode, labels: "name" | "id"): string {
  if (labels === "id") return node.id;
  return node.name ?? node.id;
}

/**
 * Assign every id a unique, word-shaped alias, in the given (sorted) order.
 * Sanitizing can collide (`java:a.b` and `java:a/b` both become `java_a_b`),
 * so a collision takes the first free `_2`, `_3`… suffix — deterministically,
 * because assignment order is the folded graph's own sorted order.
 */
function assignAliases(ids: readonly EntityId[]): Map<EntityId, string> {
  const aliases = new Map<EntityId, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    let base = id.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    let alias = base;
    for (let suffix = 2; taken.has(alias); suffix += 1) alias = `${base}_${suffix}`;
    taken.add(alias);
    aliases.set(id, alias);
  }
  return aliases;
}

/** A stereotype that only repeats the element it decorates says nothing. */
function keptStereotypes(
  element: "class" | "package",
  stereotypes: readonly string[],
): readonly string[] {
  return stereotypes.filter((stereotype) => stereotype !== element);
}

/** The PlantUML element a node of this fold level is. */
function elementFor(level: FoldLevel): "class" | "package" {
  return level === "module" ? "package" : "class";
}

/**
 * One declaration, as physical lines. A `package` needs a body — PlantUML
 * rejects `package "x" as p {}` on one line, and a braceless declaration
 * renders the ALIAS as visible text — so an empty one costs a second line,
 * while the declaration itself stays single-line, which is what makes the
 * escaping contract checkable by a line-based parse.
 */
function elementStatement(
  element: "class" | "package",
  label: string,
  alias: string,
  stereotypes: readonly string[],
  style?: string,
): readonly string[] {
  // `package "x" <<package>>` states the element twice and the model once.
  const marks = keptStereotypes(element, stereotypes)
    .map((stereotype) => ` <<${stereotype}>>`)
    .join("");
  const styled = style === undefined ? "" : ` ${style}`;
  const declaration = `${element} "${escapePlantUmlLabel(label)}" as ${alias}${marks}${styled}`;
  return element === "package" ? [`${declaration} {`, "}"] : [declaration];
}

export function toPlantUml(folded: FoldedGraph, options?: PlantUmlOptions): string {
  const labels = options?.labels ?? "name";
  const withHeader = options?.header ?? true;
  const withLegend = options?.legend ?? true;

  const element = elementFor(folded.level);
  const lines: string[] = [];
  lines.push("@startuml");

  if (withHeader) {
    const diagnostics = folded.diagnostics;
    lines.push(
      "' codegraph — rendering of a FOLDED ANALYSIS GRAPH. Not a model.jsonl.",
      `' level: ${escapeComment(folded.level)}`,
      `' view: ${escapeComment(folded.view.name)}`,
      `' nodes: ${folded.nodes.length}, edges: ${folded.edges.length}`,
      `' base edges folded: ${diagnostics.foldedEdges}, dropped: ${diagnostics.droppedEdges},` +
        ` unfoldable entities: ${diagnostics.unfoldableEntities.length}`,
    );
  }

  // The level and the view must survive into the RENDERED image, where the
  // comments above do not: an analysis picture without its view is not a fact.
  lines.push(`title codegraph — ${folded.level}-level dependencies, view ${escapePlantUmlLabel(folded.view.name)}`);
  if (element === "class") {
    // Cosmetic-only directives, and class-only: a folded type is not an OO
    // class, so the empty attribute compartments and the circled-C icon carry
    // no meaning. Packages have neither, so they need neither.
    lines.push("hide empty members");
    lines.push("hide circle");
  }

  // Aliases for declared nodes first (sorted by the folded graph), then for
  // any edge endpoint the graph never declared — which PlantUML would
  // otherwise invent as an ordinary class, silently asserting it is one.
  const orphans: EntityId[] = [];
  const known = new Set<EntityId>(folded.nodes.map((node) => node.id));
  for (const edge of folded.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!known.has(endpoint)) {
        known.add(endpoint);
        orphans.push(endpoint);
      }
    }
  }
  const sortedOrphans = sortIds(orphans);
  const aliases = assignAliases([...folded.nodes.map((node) => node.id), ...sortedOrphans]);
  const aliasOf = (id: EntityId): string => aliases.get(id) as string;

  for (const node of folded.nodes) {
    const stereotypes = node.isStub ? [node.kind, "stub"] : [node.kind];
    lines.push(
      ...elementStatement(
        element,
        labelFor(node, labels),
        aliasOf(node.id),
        stereotypes,
        node.isStub ? "#line.dashed" : undefined,
      ),
    );
  }
  for (const id of sortedOrphans) {
    lines.push(...elementStatement(element, id, aliasOf(id), ["unknown"], "#line.dotted"));
  }

  for (const edge of folded.edges) {
    const arrow = isDeclaredOnly(edge) ? "-->" : "..>";
    lines.push(`${aliasOf(edge.from)} ${arrow} ${aliasOf(edge.to)} : ${edge.count}`);
  }

  if (withLegend) {
    // A legend that explains a marker the diagram never drew is a claim about
    // nothing — at module level the kind stereotype is usually redundant with
    // the element and therefore absent.
    const kindsShown = folded.nodes.some((node) => keptStereotypes(element, [node.kind]).length > 0);
    const stubsShown = folded.nodes.some((node) => node.isStub);
    lines.push(
      "legend",
      "  how to read this diagram",
      "  ==",
      element === "package"
        ? "  a box | one module of the model; nothing below module level is drawn"
        : "  a box | one type of the model",
      "  A --> B : n | n base edges, all provenance declared",
      "  A ..> B : n | at least one base edge is an inference (derived / dynamic-candidate / generated)",
      ...(stubsShown ? ["  <<stub>> | external entity, not corpus-declared"] : []),
      ...(kindsShown ? ["  <<kind>> | the folded node's entity kind, from the model"] : []),
      "end legend",
    );
  }

  lines.push("@enduml");
  return `${lines.join("\n")}\n`;
}
