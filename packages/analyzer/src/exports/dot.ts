import type { EntityId } from "@codegraph/core";
import type { FoldedEdge, FoldedGraph, FoldedNode } from "../fold.js";
import { sortIds } from "../order.js";

/**
 * Stage 7: the DOT rendering of a folded graph (decision 7).
 *
 * A rendering is a claim about the model, so CLAUDE.md's honesty rule governs
 * it. Every visual channel here maps to one documented fact and to nothing
 * else — there are no decorative styles:
 *
 *   solid edge    the aggregated base edges are ALL provenance `declared`
 *   dashed edge   at least one aggregated base edge is an inference
 *                 (`derived` / `dynamic-candidate` / `generated`)
 *   edge label    FoldedEdge.count — the number of base edges aggregated
 *   penwidth      that same count, bucketed (1 / 2-4 / 5-16 / 17+)
 *   dashed node   FoldedNode.isStub — external, not corpus-declared
 *
 * Shape is deliberately NOT a channel: entity `kind` varies per language, so it
 * goes in the tooltip rather than being mapped to an arbitrary glyph.
 *
 * Only edges the folded graph contains are drawn. The legend lives in its own
 * cluster with synthetic node ids that are guaranteed not to collide with any
 * corpus id, so no legend line can be read as a corpus relationship.
 *
 * Deterministic: nodes and edges are emitted in the folded graph's own sorted
 * order, and penwidth is a bucket rather than a float, so two runs are
 * byte-identical on every platform.
 */

export interface DotOptions {
  /** Graph name in `digraph <name> {`. Defaults to `codegraph`. */
  readonly name?: string;
  /** Node label source. Defaults to `name` with a fallback to the id. */
  readonly labels?: "name" | "id";
  /** Emit the view/level/diagnostics as a leading DOT comment. Defaults to true. */
  readonly header?: boolean;
  /** Emit the encoding legend as a cluster subgraph. Defaults to true. */
  readonly legend?: boolean;
}

const CORPUS_FILL = "#ffffff";
const CORPUS_LINE = "#333333";
const STUB_FILL = "#f2f2f2";
const STUB_LINE = "#8a8a8a";
const DECLARED_LINE = "#333333";
const INFERRED_LINE = "#8a8a8a";

/**
 * Quote and escape an arbitrary string as a DOT id/label, quotes included.
 *
 * Correctness, not cosmetics: entity ids carry `:` `/` `#` `(` `)` `<` `>` `,`
 * `[` `]` `$`, and a Java signature id can contain a quote or a backslash. In a
 * DOT quoted string a backslash introduces an escape (`\n`, `\l`, `\N`, `\G`…),
 * so a literal backslash must be doubled BEFORE anything else is escaped.
 * Control characters other than newline cannot appear in a quoted string at
 * all; they become spaces, which is lossy but never produces invalid DOT.
 */
export function escapeDot(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ");
  return `"${escaped}"`;
}

/** Comment text can never terminate a comment or start a new line. */
function escapeComment(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /");
}

/** Bucketed so the output is byte-stable: no float formatting in the render. */
function penwidth(count: number): string {
  if (count >= 17) return "4";
  if (count >= 5) return "3";
  if (count >= 2) return "2";
  return "1";
}

function isDeclaredOnly(edge: FoldedEdge): boolean {
  return edge.provenances.size === 1 && edge.provenances.has("declared");
}

function labelFor(node: FoldedNode, labels: "name" | "id"): string {
  if (labels === "id") return node.id;
  return node.name ?? node.id;
}

function nodeTooltip(node: FoldedNode): string {
  const members = `${node.members} member${node.members === 1 ? "" : "s"}`;
  const origin = node.isStub ? "stub, external" : "corpus-declared";
  return `${node.id} — ${node.kind}, ${origin}, ${members}`;
}

function edgeTooltip(edge: FoldedEdge): string {
  const kinds = sortIds(edge.kinds).join(", ");
  const provenances = sortIds(edge.provenances).join(", ");
  const self = edge.selfLoop ? "; folding-induced self-loop" : "";
  return `${edge.count} base edge${edge.count === 1 ? "" : "s"}; kinds: ${kinds}; provenance: ${provenances}${self}`;
}

function attributes(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([key, value]) => `${key}=${escapeDot(value)}`).join(", ");
}

/** A legend id prefix no corpus id can collide with — ids are opaque, so verify. */
function legendPrefix(ids: readonly EntityId[]): string {
  let prefix = "__codegraph_legend__";
  while (ids.some((id) => id.startsWith(prefix))) prefix += "_";
  return prefix;
}

function nodeStatement(
  id: string,
  pairs: readonly (readonly [string, string])[],
  indent = "  ",
): string {
  return `${indent}${escapeDot(id)} [${attributes(pairs)}];`;
}

export function toDot(folded: FoldedGraph, options?: DotOptions): string {
  const graphName = options?.name ?? "codegraph";
  const labels = options?.labels ?? "name";
  const withHeader = options?.header ?? true;
  const withLegend = options?.legend ?? true;

  const lines: string[] = [];

  if (withHeader) {
    const diagnostics = folded.diagnostics;
    lines.push(
      "// codegraph — rendering of a FOLDED ANALYSIS GRAPH. Not a model.json.",
      `// level: ${escapeComment(folded.level)}`,
      `// view: ${escapeComment(folded.view.name)}`,
      `// nodes: ${folded.nodes.length}, edges: ${folded.edges.length}`,
      `// base edges folded: ${diagnostics.foldedEdges}, dropped: ${diagnostics.droppedEdges},` +
        ` unfoldable entities: ${diagnostics.unfoldableEntities.length}`,
      "// encoding: solid edge = declared fact; dashed edge = contains an inference;",
      "//           edge label and penwidth = aggregated base-edge count;",
      "//           dashed node = stub (external, not corpus-declared).",
    );
  }

  lines.push(`digraph ${escapeDot(graphName)} {`);
  lines.push(`  graph [${attributes([["rankdir", "LR"], ["fontname", "Helvetica"]])}];`);
  lines.push(
    `  node [${attributes([
      ["shape", "box"],
      ["style", "filled"],
      ["fontname", "Helvetica"],
      ["fontsize", "10"],
    ])}];`,
  );
  lines.push(`  edge [${attributes([["fontname", "Helvetica"], ["fontsize", "9"]])}];`);

  const declared = new Set<EntityId>();
  for (const node of folded.nodes) {
    declared.add(node.id);
    lines.push(
      nodeStatement(node.id, [
        ["label", labelFor(node, labels)],
        ["tooltip", nodeTooltip(node)],
        ["style", node.isStub ? "filled,dashed" : "filled"],
        ["fillcolor", node.isStub ? STUB_FILL : CORPUS_FILL],
        ["color", node.isStub ? STUB_LINE : CORPUS_LINE],
      ]),
    );
  }

  // An endpoint the folded graph never declared as a node would otherwise be
  // invented by graphviz with default styling, silently asserting it is a
  // corpus entity. Declare it explicitly, marked unknown.
  const orphans: EntityId[] = [];
  for (const edge of folded.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!declared.has(endpoint)) {
        declared.add(endpoint);
        orphans.push(endpoint);
      }
    }
  }
  for (const id of sortIds(orphans)) {
    lines.push(
      nodeStatement(id, [
        ["label", id],
        ["tooltip", `${id} — endpoint with no folded node (analyzer bug or partial graph)`],
        ["style", "filled,dotted"],
        ["fillcolor", STUB_FILL],
        ["color", STUB_LINE],
      ]),
    );
  }

  for (const edge of folded.edges) {
    const factual = isDeclaredOnly(edge);
    lines.push(
      `  ${escapeDot(edge.from)} -> ${escapeDot(edge.to)} [${attributes([
        ["label", String(edge.count)],
        ["tooltip", edgeTooltip(edge)],
        ["style", factual ? "solid" : "dashed"],
        ["color", factual ? DECLARED_LINE : INFERRED_LINE],
        ["penwidth", penwidth(edge.count)],
      ])}];`,
    );
  }

  if (withLegend) {
    const prefix = legendPrefix([...declared]);
    const key = (suffix: string): string => `${prefix}${suffix}`;
    lines.push(`  subgraph ${escapeDot(`cluster_${prefix}`)} {`);
    lines.push(
      `    graph [${attributes([
        ["label", "legend — how to read this graph"],
        ["style", "dashed"],
        ["color", STUB_LINE],
        ["fontsize", "10"],
      ])}];`,
    );
    lines.push(
      nodeStatement(
        key("corpus"),
        [
          ["label", "corpus entity"],
          ["style", "filled"],
          ["fillcolor", CORPUS_FILL],
          ["color", CORPUS_LINE],
        ],
        "    ",
      ),
    );
    lines.push(
      nodeStatement(
        key("stub"),
        [
          ["label", "stub (external)"],
          ["style", "filled,dashed"],
          ["fillcolor", STUB_FILL],
          ["color", STUB_LINE],
        ],
        "    ",
      ),
    );
    for (const suffix of ["fact_a", "fact_b", "inference_a", "inference_b"]) {
      lines.push(
        nodeStatement(
          key(suffix),
          [
            ["label", ""],
            ["shape", "point"],
            ["style", "filled"],
            ["fillcolor", CORPUS_LINE],
            ["width", "0.06"],
          ],
          "    ",
        ),
      );
    }
    lines.push(
      `    ${escapeDot(key("fact_a"))} -> ${escapeDot(key("fact_b"))} [${attributes([
        ["label", "declared fact (n = base edges)"],
        ["style", "solid"],
        ["color", DECLARED_LINE],
      ])}];`,
    );
    lines.push(
      `    ${escapeDot(key("inference_a"))} -> ${escapeDot(key("inference_b"))} [${attributes([
        ["label", "contains an inference (derived / dynamic-candidate / generated)"],
        ["style", "dashed"],
        ["color", INFERRED_LINE],
      ])}];`,
    );
    lines.push("  }");
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}
