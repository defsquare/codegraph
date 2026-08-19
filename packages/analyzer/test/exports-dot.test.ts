import { describe, expect, it } from "vitest";
import { escapeDot, toDot } from "../src/exports/dot.js";
import { foldGraph } from "../src/fold.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import { ADVERSARIAL_IDS, foldedEdge, foldedNode, makeFolded } from "./exports-fixture.js";
import { javaGraph } from "./fixture.js";

/**
 * Graphviz is NOT installed on this machine, so DOT is verified STRUCTURALLY.
 * `parseDot` below is a real (small) lexer: it tracks quoted strings with their
 * backslash escapes, `//` and block comments, and brace/bracket nesting. If an
 * id containing a quote, a backslash or a newline broke the quoting, the string
 * would never close and this throws — which is the whole point, because a DOT
 * export a real corpus can break is not an export.
 */
interface ParsedDot {
  /** Statement text with every quoted string replaced by its decoded value. */
  readonly statements: readonly string[];
  /** Decoded contents of every quoted string, in order. */
  readonly strings: readonly string[];
  /** `from -> to` pairs, decoded, at nesting depth 1 (i.e. outside any cluster). */
  readonly topLevelEdges: readonly (readonly [string, string])[];
  readonly clusters: number;
}

function parseDot(source: string): ParsedDot {
  const strings: string[] = [];
  const statements: string[] = [];
  const topLevelEdges: [string, string][] = [];
  let clusters = 0;
  let depth = 0;
  let bracket = 0;
  let current = "";
  // Tokens of the current statement, with strings decoded, for edge detection.
  let tokens: (string | "->")[] = [];
  let i = 0;

  const flush = (): void => {
    const text = current.trim();
    if (text.length > 0) statements.push(text);
    const arrow = tokens.indexOf("->");
    if (arrow > 0 && depth === 1) {
      const from = tokens[arrow - 1];
      const to = tokens[arrow + 1];
      if (typeof from === "string" && typeof to === "string" && from !== "->" && to !== "->") {
        topLevelEdges.push([from, to]);
      }
    }
    current = "";
    tokens = [];
  };

  while (i < source.length) {
    const char = source[i] as string;
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated block comment");
      i = end + 2;
      continue;
    }
    if (char === '"') {
      let decoded = "";
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const inner = source[j] as string;
        if (inner === "\\") {
          const next = source[j + 1];
          if (next === undefined) throw new Error("dangling escape inside quoted string");
          decoded += next === "n" ? "\n" : next;
          j += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (inner === "\n") throw new Error(`raw newline inside quoted string near offset ${i}`);
        decoded += inner;
        j += 1;
      }
      if (!closed) throw new Error(`unterminated quoted string near offset ${i}`);
      strings.push(decoded);
      current += "STR";
      tokens.push(decoded);
      i = j;
      continue;
    }
    if (char === "[") {
      bracket += 1;
      current += char;
      i += 1;
      continue;
    }
    if (char === "]") {
      bracket -= 1;
      if (bracket < 0) throw new Error("unbalanced ]");
      current += char;
      i += 1;
      continue;
    }
    if (bracket === 0 && (char === "{" || char === "}" || char === ";")) {
      if (char === "{") {
        if (current.includes("subgraph")) clusters += 1;
        flush();
        depth += 1;
      } else if (char === "}") {
        flush();
        depth -= 1;
        if (depth < 0) throw new Error("unbalanced }");
      } else {
        flush();
      }
      i += 1;
      continue;
    }
    if (char === "-" && source[i + 1] === ">" && bracket === 0) {
      current += "->";
      tokens.push("->");
      i += 2;
      continue;
    }
    current += char;
    i += 1;
  }

  if (depth !== 0) throw new Error(`unbalanced braces: depth ${depth} at end`);
  if (bracket !== 0) throw new Error(`unbalanced brackets: ${bracket} at end`);
  if (current.trim().length > 0) throw new Error(`unterminated trailing statement: ${current.trim()}`);
  return { statements, strings, topLevelEdges, clusters };
}

describe("escapeDot", () => {
  it("always returns a quoted string", () => {
    expect(escapeDot("x")).toBe('"x"');
    expect(escapeDot("")).toBe('""');
  });

  it("escapes the three characters that break DOT quoting", () => {
    expect(escapeDot('say("hi")')).toBe('"say(\\"hi\\")"');
    // A lone backslash would start a DOT escape sequence, so it is doubled.
    expect(escapeDot("a\\b")).toBe('"a\\\\b"');
    expect(escapeDot("line1\nline2")).toBe('"line1\\nline2"');
    // CR is a control character, not a line break DOT understands: it gets its
    // own escape, so CRLF stays distinguishable from a bare LF.
    expect(escapeDot("crlf\r\nnext")).toBe('"crlf\\u000d\\nnext"');
  });

  it("escapes the backslash before the quote, never after", () => {
    // '\"' must become '\\\"': doubling after quoting would re-arm the escape.
    expect(escapeDot('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("passes the punctuation real ids are made of through untouched", () => {
    const id = ADVERSARIAL_IDS.signature;
    expect(escapeDot(id)).toBe(`"${id}"`);
  });

  it("neutralizes control characters rather than emitting them raw", () => {
    // A raw control character cannot appear in a DOT quoted string at all, so
    // it is rendered as its own escape — never emitted, never dropped.
    expect(escapeDot("a\tb")).toBe('"a\\u0009b"');
    expect(escapeDot("a\u0000b")).toBe('"a\\u0000b"');
    expect(escapeDot("a\u007fb")).toBe('"a\\u007fb"');
  });

  it("keeps ids that differ only by a control character distinct", () => {
    // Ids are opaque (CLAUDE.md invariant 7). Mapping every control character
    // onto one replacement would render two DIFFERENT nodes under the SAME DOT
    // id, silently merging them and drawing edges the model never contained.
    const rendered = ["a\tb", "a b", "a\u0000b", "a\u000bb", "a\\u0009b"].map(escapeDot);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("keeps CR distinct from LF, which is a real DOT line break", () => {
    expect(escapeDot("a\nb")).toBe('"a\\nb"');
    expect(escapeDot("a\r\nb")).not.toBe(escapeDot("a\nb"));
  });
});

describe("toDot on the Java fixture", () => {
  const graph = javaGraph();

  for (const level of ["module", "type"] as const) {
    it(`renders a structurally valid graph at ${level} level`, () => {
      const folded = foldGraph(graph, { level });
      const parsed = parseDot(toDot(folded));
      expect(parsed.statements.length).toBeGreaterThan(0);
      expect(parsed.clusters).toBe(1); // the legend
    });
  }

  it("draws exactly the edges the folded graph contains, and no others", () => {
    const folded = foldGraph(graph, { level: "module" });
    const parsed = parseDot(toDot(folded, { legend: false }));
    const drawn = parsed.topLevelEdges.map(([from, to]) => `${from} -> ${to}`).sort();
    const expected = folded.edges.map((edge) => `${edge.from} -> ${edge.to}`).sort();
    expect(drawn).toEqual(expected);
    expect(drawn).toHaveLength(32); // measured: the fixture's module-level fold
  });

  it("declares a node statement for every folded node", () => {
    const folded = foldGraph(graph, { level: "type" });
    const dot = toDot(folded, { legend: false });
    for (const node of folded.nodes) {
      expect(dot).toContain(`${escapeDot(node.id)} [`);
    }
  });

  it("renders the derived module import edge dashed and the declared ones solid", () => {
    // Measured fact: com.acme.order -> com.megacorp.ledger is `derived` (the
    // source declares a TYPE import; the module edge is the extractor's
    // inference), while the other import edges are declared.
    const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
    const dot = toDot(folded, { legend: false });
    const lines = dot.split("\n");
    const derived = lines.find((text) =>
      text.startsWith('  "java:com.acme.order" -> "java:com.megacorp.ledger" ['),
    );
    expect(derived).toBeDefined();
    expect(derived).toContain('style="dashed"');
    expect(derived).toContain("provenance: derived");

    const declared = lines.find((text) =>
      text.startsWith('  "java:com.acme.order" -> "java:java.lang.annotation" ['),
    );
    expect(declared).toBeDefined();
    expect(declared).toContain('style="solid"');
  });

  it("keeps stub nodes visually distinct from corpus nodes", () => {
    const folded = foldGraph(graph, { level: "module" });
    const dot = toDot(folded, { legend: false });
    const lines = dot.split("\n");
    const stub = folded.nodes.find((node) => node.isStub);
    const corpus = folded.nodes.find((node) => !node.isStub);
    expect(stub).toBeDefined();
    expect(corpus).toBeDefined();
    const stubLine = lines.find((text) => text.startsWith(`  ${escapeDot(stub!.id)} [`));
    const corpusLine = lines.find((text) => text.startsWith(`  ${escapeDot(corpus!.id)} [`));
    expect(stubLine).toContain('style="filled,dashed"');
    expect(corpusLine).toContain('style="filled"');
    expect(corpusLine).not.toContain("dashed");
  });

  it("puts the aggregated weight on the edge", () => {
    const folded = foldGraph(graph, { level: "module" });
    const dot = toDot(folded, { legend: false });
    const heaviest = [...folded.edges].sort((a, b) => b.count - a.count)[0];
    expect(heaviest).toBeDefined();
    const line = dot
      .split("\n")
      .find((text) => text.startsWith(`  ${escapeDot(heaviest!.from)} -> ${escapeDot(heaviest!.to)}`));
    expect(line).toContain(`label="${heaviest!.count}"`);
    expect(line).toContain('penwidth="4"'); // 89 base edges -> the top bucket
  });

  it("states the view and level in the header, and honours header:false", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const folded = foldGraph(graph, { level: "module", view });
    const dot = toDot(folded);
    expect(dot).toContain("// level: module");
    expect(dot).toContain("// view: internalOnly+declaredOnly");
    expect(dot).toContain("Not a model.json");
    expect(toDot(folded, { header: false }).startsWith("digraph")).toBe(true);
  });

  it("labels by name by default and by id on request", () => {
    const folded = foldGraph(graph, { level: "type" });
    const named = toDot(folded, { legend: false });
    const byId = toDot(folded, { legend: false, labels: "id" });
    expect(named).toContain('label="Basket"');
    expect(byId).not.toContain('label="Basket"');
    expect(byId).toContain('label="java:com.acme.order/Basket"');
  });

  it("is byte-identical across runs", () => {
    const folded = foldGraph(graph, { level: "type" });
    expect(toDot(folded)).toBe(toDot(foldGraph(javaGraph(), { level: "type" })));
  });
});

describe("toDot escaping and honesty on adversarial input", () => {
  const nodes = [
    foldedNode(ADVERSARIAL_IDS.quote, { name: 'say("hi")' }),
    foldedNode(ADVERSARIAL_IDS.backslash, { name: "path\\to\\thing", isStub: true }),
    foldedNode(ADVERSARIAL_IDS.newline, { name: "line1\nline2" }),
    foldedNode(ADVERSARIAL_IDS.signature),
  ];
  const edges = [
    foldedEdge(ADVERSARIAL_IDS.quote, ADVERSARIAL_IDS.backslash, { count: 7 }),
    foldedEdge(ADVERSARIAL_IDS.newline, ADVERSARIAL_IDS.signature, {
      count: 2,
      provenances: new Set(["derived"]),
    }),
  ];

  it("survives quotes, backslashes and newlines in ids and names", () => {
    const parsed = parseDot(toDot(makeFolded(nodes, edges)));
    // The ids came back out of the lexer intact — quoting was reversible.
    for (const id of [
      ADVERSARIAL_IDS.quote,
      ADVERSARIAL_IDS.backslash,
      ADVERSARIAL_IDS.newline,
      ADVERSARIAL_IDS.signature,
    ]) {
      expect(parsed.strings).toContain(id);
    }
  });

  it("still draws exactly two edges, with the right endpoints", () => {
    const parsed = parseDot(toDot(makeFolded(nodes, edges), { legend: false }));
    expect(parsed.topLevelEdges).toEqual([
      [ADVERSARIAL_IDS.newline, ADVERSARIAL_IDS.signature],
      [ADVERSARIAL_IDS.quote, ADVERSARIAL_IDS.backslash],
    ]);
  });

  it("declares an undeclared endpoint instead of letting graphviz invent it", () => {
    // If a folded graph ever carried an edge to a node it does not list, the
    // renderer must not imply the endpoint is an ordinary corpus entity.
    const folded = makeFolded([foldedNode("a")], [foldedEdge("a", "ghost")]);
    const dot = toDot(folded, { legend: false });
    expect(dot).toContain('"ghost" [');
    expect(dot).toContain("no folded node");
    expect(parseDot(dot).topLevelEdges).toEqual([["a", "ghost"]]);
  });

  it("gives the legend ids that cannot collide with a corpus id", () => {
    const hostile = foldedNode("__codegraph_legend__corpus", { name: "Corpus" });
    const dot = toDot(makeFolded([hostile], []));
    const parsed = parseDot(dot);
    expect(parsed.clusters).toBe(1);
    // The legend backed off to a longer prefix rather than redefining the node.
    expect(parsed.strings.filter((text) => text === "__codegraph_legend__corpus")).toHaveLength(1);
    expect(dot).toContain('"__codegraph_legend___corpus"');
  });

  it("keeps every legend edge inside the legend cluster", () => {
    const folded = makeFolded(nodes, edges);
    const withLegend = parseDot(toDot(folded));
    const withoutLegend = parseDot(toDot(folded, { legend: false }));
    // Legend edges are nested, so they never appear at the top level.
    expect(withLegend.topLevelEdges).toEqual(withoutLegend.topLevelEdges);
  });

  it("buckets penwidth deterministically instead of formatting a float", () => {
    const widths = [1, 2, 4, 5, 16, 17, 500].map((count) => {
      const dot = toDot(makeFolded([foldedNode("a"), foldedNode("b")], [foldedEdge("a", "b", { count })]), {
        legend: false,
        header: false,
      });
      return /penwidth="(\d+)"/.exec(dot)?.[1];
    });
    expect(widths).toEqual(["1", "2", "2", "3", "3", "4", "4"]);
  });

  it("renders an empty folded graph as a valid, empty digraph", () => {
    const parsed = parseDot(toDot(makeFolded([], [])));
    expect(parsed.topLevelEdges).toEqual([]);
  });
});
