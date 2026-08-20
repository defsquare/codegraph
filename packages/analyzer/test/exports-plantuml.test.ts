import { describe, expect, it } from "vitest";
import { escapePlantUmlLabel, toPlantUml } from "../src/exports/plantuml.js";
import { foldGraph } from "../src/fold.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import { ADVERSARIAL_IDS, foldedEdge, foldedNode, makeFolded } from "./exports-fixture.js";
import { javaGraph } from "./fixture.js";

/**
 * PlantUML is NOT installed on this machine, so the artifact is verified
 * STRUCTURALLY, exactly as the DOT export is. The escaping contract makes every
 * statement a single physical line, so a line-based parse is a real parse: if a
 * quote, a backslash or a newline in an id broke the quoting, the class line
 * would not match its grammar — or worse, would span two lines — and this
 * parser throws.
 */
interface ParsedPlantUml {
  /** alias -> decoded display label, in declaration order. */
  readonly classes: ReadonlyMap<string, string>;
  /** alias -> raw class line (stereotypes, styles). */
  readonly classLines: ReadonlyMap<string, string>;
  /** [fromAlias, arrow, toAlias, label] in declaration order. */
  readonly edges: readonly (readonly [string, string, string, string | undefined])[];
  readonly hasLegend: boolean;
  readonly title: string | undefined;
}

/** Reverse of `escapePlantUmlLabel`: every `<U+XXXX>` back to its character. */
function decodeLabel(escaped: string): string {
  return escaped.replace(/<U\+([0-9a-fA-F]{4})>/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function parsePlantUml(source: string): ParsedPlantUml {
  const lines = source.split("\n");
  if (source.at(-1) !== "\n") throw new Error("missing trailing newline");

  const classes = new Map<string, string>();
  const classLines = new Map<string, string>();
  const edges: (readonly [string, string, string, string | undefined])[] = [];
  let hasLegend = false;
  let inLegend = false;
  let title: string | undefined;
  let started = false;
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (line === "@startuml") {
      if (started) throw new Error("duplicate @startuml");
      started = true;
      continue;
    }
    if (line === "@enduml") {
      if (!started || ended) throw new Error("misplaced @enduml");
      ended = true;
      continue;
    }
    if (ended) throw new Error(`content after @enduml: ${line}`);
    if (line.startsWith("'")) continue; // comment
    if (!started) throw new Error(`content before @startuml: ${line}`);

    if (line === "legend") {
      hasLegend = true;
      inLegend = true;
      continue;
    }
    if (line === "end legend") {
      inLegend = false;
      continue;
    }
    if (inLegend) continue;

    if (line.startsWith("title ")) {
      title = line.slice("title ".length);
      continue;
    }
    if (line.startsWith("hide ") || line.startsWith("skinparam ")) continue;

    const classMatch = /^class "((?:[^"\n])*)" as ([A-Za-z_][A-Za-z0-9_]*)(?: .*)?$/.exec(line);
    if (classMatch !== null) {
      const [, label, alias] = classMatch as unknown as [string, string, string];
      if (classes.has(alias)) throw new Error(`alias declared twice: ${alias}`);
      // A raw quote inside the label would have truncated the match; a decoded
      // label containing one proves the escaping round-trips instead.
      classes.set(alias, decodeLabel(label));
      classLines.set(alias, line);
      continue;
    }

    const edgeMatch =
      /^([A-Za-z_][A-Za-z0-9_]*) (-->|\.\.>) ([A-Za-z_][A-Za-z0-9_]*)(?: : (.+))?$/.exec(line);
    if (edgeMatch !== null) {
      const [, from, arrow, to, label] = edgeMatch as unknown as [
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      edges.push([from, arrow, to, label]);
      continue;
    }

    throw new Error(`unrecognized statement: ${line}`);
  }

  if (!started || !ended) throw new Error("missing @startuml/@enduml pair");
  return { classes, classLines, edges, hasLegend, title };
}

describe("escapePlantUmlLabel", () => {
  it("escapes the characters PlantUML would interpret", () => {
    // A quote would close the quoted class name; `<` opens a creole tag; a
    // backslash arms `\n`; a newline splits the statement across lines.
    expect(escapePlantUmlLabel('say("hi")')).toBe("say(<U+0022>hi<U+0022>)");
    expect(escapePlantUmlLabel("a<b>c")).toBe("a<U+003C>b>c");
    expect(escapePlantUmlLabel("a\\b")).toBe("a<U+005C>b");
    expect(escapePlantUmlLabel("line1\nline2")).toBe("line1<U+000A>line2");
  });

  it("neutralizes every control character", () => {
    expect(escapePlantUmlLabel("a\tb")).toBe("a<U+0009>b");
    expect(escapePlantUmlLabel("a\u0000b")).toBe("a<U+0000>b");
    expect(escapePlantUmlLabel("a\u007fb")).toBe("a<U+007F>b");
    expect(escapePlantUmlLabel("crlf\r\nnext")).toBe("crlf<U+000D><U+000A>next");
  });

  it("passes the punctuation real ids are made of through untouched", () => {
    // `<` is escaped (creole), the rest of a signature id survives literally.
    expect(escapePlantUmlLabel("java:com.acme/Order#pay(int[],Foo$Bar)")).toBe(
      "java:com.acme/Order#pay(int[],Foo$Bar)",
    );
  });

  it("is injective: two different labels never render identically", () => {
    // `<` is escaped too, so a label that already contains the literal text
    // `<U+0022>` cannot collide with an escaped quote.
    const inputs = ['a"b', "a<U+0022>b", "a\tb", "a\\u0009b", "a<b", "a<U+0009>b"];
    const rendered = inputs.map(escapePlantUmlLabel);
    expect(new Set(inputs).size).toBe(inputs.length);
    expect(new Set(rendered).size).toBe(inputs.length);
  });

  it("round-trips through the test decoder", () => {
    for (const id of Object.values(ADVERSARIAL_IDS)) {
      expect(decodeLabel(escapePlantUmlLabel(id))).toBe(id);
    }
  });
});

describe("toPlantUml on the Java fixture", () => {
  const graph = javaGraph();

  for (const level of ["module", "type"] as const) {
    it(`renders a structurally valid diagram at ${level} level`, () => {
      const folded = foldGraph(graph, { level });
      const parsed = parsePlantUml(toPlantUml(folded));
      expect(parsed.classes.size).toBe(folded.nodes.length);
      expect(parsed.edges.length).toBe(folded.edges.length);
      expect(parsed.hasLegend).toBe(true);
    });
  }

  it("declares one class per folded node and draws exactly the folded edges", () => {
    const folded = foldGraph(graph, { level: "module" });
    const parsed = parsePlantUml(toPlantUml(folded, { labels: "id", legend: false }));
    // With id labels, alias -> label inverts to id -> alias.
    const aliasFor = new Map([...parsed.classes].map(([alias, id]) => [id, alias] as const));
    expect(aliasFor.size).toBe(folded.nodes.length);
    const drawn = parsed.edges.map(([from, , to]) => `${from} => ${to}`).sort();
    const expected = folded.edges
      .map((edge) => `${aliasFor.get(edge.from)} => ${aliasFor.get(edge.to)}`)
      .sort();
    expect(drawn).toEqual(expected);
    expect(drawn).toHaveLength(14); // measured: the fixture's module-level fold
  });

  it("renders the derived module import edge dashed and the declared ones solid", () => {
    // Same measured fact the DOT suite pins: com.acme.order ->
    // com.megacorp.ledger is `derived`; the other import edges are declared.
    const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
    const parsed = parsePlantUml(toPlantUml(folded, { labels: "id", legend: false }));
    const aliasFor = new Map([...parsed.classes].map(([alias, id]) => [id, alias] as const));
    const arrow = (from: string, to: string): string | undefined =>
      parsed.edges.find(
        ([f, , t]) => f === aliasFor.get(from) && t === aliasFor.get(to),
      )?.[1];
    expect(arrow("java:com.acme.order", "java:com.megacorp.ledger")).toBe("..>");
    expect(arrow("java:com.acme.order", "java:java.lang.annotation")).toBe("-->");
  });

  it("marks stub nodes with the <<stub>> stereotype and corpus nodes without", () => {
    const folded = foldGraph(graph, { level: "module" });
    const parsed = parsePlantUml(toPlantUml(folded, { labels: "id", legend: false }));
    const stub = folded.nodes.find((node) => node.isStub);
    const corpus = folded.nodes.find((node) => !node.isStub);
    expect(stub).toBeDefined();
    expect(corpus).toBeDefined();
    const lineFor = (id: string): string | undefined => {
      for (const [alias, label] of parsed.classes) {
        if (label === id) return parsed.classLines.get(alias);
      }
      return undefined;
    };
    expect(lineFor(stub!.id)).toContain("<<stub>>");
    expect(lineFor(corpus!.id)).not.toContain("<<stub>>");
  });

  it("puts the aggregated weight on the edge", () => {
    const folded = foldGraph(graph, { level: "module" });
    const parsed = parsePlantUml(toPlantUml(folded, { labels: "id", legend: false }));
    const aliasFor = new Map([...parsed.classes].map(([alias, id]) => [id, alias] as const));
    const heaviest = [...folded.edges].sort((a, b) => b.count - a.count)[0];
    expect(heaviest).toBeDefined();
    const edge = parsed.edges.find(
      ([from, , to]) => from === aliasFor.get(heaviest!.from) && to === aliasFor.get(heaviest!.to),
    );
    expect(edge?.[3]).toBe(String(heaviest!.count));
  });

  it("states the level and the view in the rendered title", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const folded = foldGraph(graph, { level: "module", view });
    const parsed = parsePlantUml(toPlantUml(folded));
    expect(parsed.title).toContain("module");
    expect(parsed.title).toContain("internalOnly+declaredOnly");
  });

  it("states in a comment that this is not a model.json, and honours header:false", () => {
    const folded = foldGraph(graph, { level: "module" });
    expect(toPlantUml(folded)).toContain("Not a model.json");
    const bare = toPlantUml(folded, { header: false });
    expect(bare).not.toContain("Not a model.json");
    expect(bare.startsWith("@startuml")).toBe(true);
  });

  it("labels by name by default and by id on request", () => {
    const folded = foldGraph(graph, { level: "type" });
    const named = parsePlantUml(toPlantUml(folded, { legend: false }));
    const byId = parsePlantUml(toPlantUml(folded, { legend: false, labels: "id" }));
    expect([...named.classes.values()]).toContain("Basket");
    expect([...byId.classes.values()]).not.toContain("Basket");
    expect([...byId.classes.values()]).toContain("java:com.acme.order/Basket");
  });

  it("omits the legend on request", () => {
    const folded = foldGraph(graph, { level: "module" });
    expect(parsePlantUml(toPlantUml(folded, { legend: false })).hasLegend).toBe(false);
  });

  it("is byte-identical across runs", () => {
    const folded = foldGraph(graph, { level: "type" });
    expect(toPlantUml(folded)).toBe(toPlantUml(foldGraph(javaGraph(), { level: "type" })));
  });
});

describe("toPlantUml escaping and honesty on adversarial input", () => {
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

  it("survives quotes, backslashes and newlines in ids", () => {
    const parsed = parsePlantUml(toPlantUml(makeFolded(nodes, edges), { labels: "id" }));
    // The ids came back out of the decoder intact — escaping was reversible.
    for (const id of [
      ADVERSARIAL_IDS.quote,
      ADVERSARIAL_IDS.backslash,
      ADVERSARIAL_IDS.newline,
      ADVERSARIAL_IDS.signature,
    ]) {
      expect([...parsed.classes.values()]).toContain(id);
    }
  });

  it("still draws exactly two edges, with the right endpoints", () => {
    const parsed = parsePlantUml(
      toPlantUml(makeFolded(nodes, edges), { labels: "id", legend: false }),
    );
    const aliasFor = new Map([...parsed.classes].map(([alias, id]) => [id, alias] as const));
    expect(parsed.edges.map(([from, arrow, to]) => [from, arrow, to])).toEqual([
      [aliasFor.get(ADVERSARIAL_IDS.newline), "..>", aliasFor.get(ADVERSARIAL_IDS.signature)],
      [aliasFor.get(ADVERSARIAL_IDS.quote), "-->", aliasFor.get(ADVERSARIAL_IDS.backslash)],
    ]);
  });

  it("gives colliding sanitized ids distinct aliases", () => {
    // Both sanitize to the same identifier; merging them would draw edges
    // between things the model never related.
    const folded = makeFolded(
      [foldedNode("java:a.b"), foldedNode("java:a/b")],
      [foldedEdge("java:a.b", "java:a/b")],
    );
    const parsed = parsePlantUml(toPlantUml(folded, { labels: "id", legend: false }));
    expect(parsed.classes.size).toBe(2);
    const [edge] = parsed.edges;
    expect(edge).toBeDefined();
    expect(edge![0]).not.toBe(edge![2]);
  });

  it("declares an undeclared endpoint instead of letting PlantUML invent it", () => {
    const folded = makeFolded([foldedNode("a")], [foldedEdge("a", "ghost")]);
    const rendered = toPlantUml(folded, { labels: "id", legend: false });
    const parsed = parsePlantUml(rendered);
    expect([...parsed.classes.values()]).toContain("ghost");
    const ghostAlias = [...parsed.classes].find(([, label]) => label === "ghost")?.[0];
    expect(parsed.classLines.get(ghostAlias ?? "")).toContain("<<unknown>>");
  });

  it("renders an empty folded graph as a valid, empty diagram", () => {
    const parsed = parsePlantUml(toPlantUml(makeFolded([], [])));
    expect(parsed.classes.size).toBe(0);
    expect(parsed.edges).toEqual([]);
  });
});
