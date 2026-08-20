import { describe, expect, it } from "vitest";
import { couplingToCsv, cyclesToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { foldGraph } from "../src/fold.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";
import {
  ADVERSARIAL_IDS,
  couplingRow,
  couplingTable,
  cycleReport,
  foldedEdge,
  foldedNode,
  makeFolded,
  scc,
} from "./exports-fixture.js";
import { javaGraph } from "./fixture.js";

/**
 * RFC 4180 parser used as the oracle: if the writer's quoting is wrong, this
 * reader recovers the wrong fields and the round-trip assertions fail. Records
 * are LF-separated, which is what the writer emits.
 */
function parseCsv(source: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let pending = false; // a field has been started on this row

  while (i < source.length) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      pending = true;
      i += 1;
      continue;
    }
    if (source.startsWith(delimiter, i)) {
      row.push(field);
      field = "";
      pending = true;
      i += delimiter.length;
      continue;
    }
    if (char === "\n") {
      if (pending || field !== "") row.push(field);
      rows.push(row);
      row = [];
      field = "";
      pending = false;
      i += 1;
      continue;
    }
    field += char;
    pending = true;
    i += 1;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (pending || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const FOLDED_COLUMNS = ["from", "to", "count", "kinds", "provenances", "selfLoop", "level", "view"];

describe("foldedGraphToCsv", () => {
  const graph = javaGraph();

  it("renders one row per folded edge, with the documented columns", () => {
    const folded = foldGraph(graph, { level: "module" });
    const rows = parseCsv(foldedGraphToCsv(folded));
    expect(rows[0]).toEqual(FOLDED_COLUMNS);
    expect(rows).toHaveLength(folded.edges.length + 1);
    expect(folded.edges).toHaveLength(14); // measured: the fixture's module fold
  });

  it("carries the view and level on every row, not only in a header", () => {
    const view = composeViews(internalOnly, declaredOnly);
    const folded = foldGraph(graph, { level: "module", view });
    const rows = parseCsv(foldedGraphToCsv(folded, { header: false }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row[6]).toBe("module");
      expect(row[7]).toBe("internalOnly+declaredOnly");
    }
  });

  it("keeps the derived module import edge labelled as an inference", () => {
    const folded = foldGraph(graph, { level: "module", edgeKinds: ["import"] });
    const rows = parseCsv(foldedGraphToCsv(folded)).slice(1);
    const derived = rows.find((row) => row[1] === "java:com.megacorp.ledger");
    expect(derived).toBeDefined();
    expect(derived?.[4]).toBe("derived");
    const declared = rows.find((row) => row[1] === "java:java.lang.annotation");
    expect(declared?.[4]).toBe("declared");
  });

  it("renders sets as sorted lists so runs are byte-identical", () => {
    const folded = foldGraph(graph, { level: "module" });
    const rows = parseCsv(foldedGraphToCsv(folded)).slice(1);
    const selfLoop = rows.find((row) => row[0] === "java:com.acme.order" && row[5] === "true");
    expect(selfLoop?.[3]).toBe(
      "access;inheritance;interfaceImplementation;invocation;reference",
    );
    expect(foldedGraphToCsv(folded)).toBe(
      foldedGraphToCsv(foldGraph(javaGraph(), { level: "module" })),
    );
  });

  it("honours header:false and a custom delimiter", () => {
    const folded = foldGraph(graph, { level: "type" });
    expect(parseCsv(foldedGraphToCsv(folded, { header: false }))[0]?.[0]).not.toBe("from");
    const semi = foldedGraphToCsv(folded, { delimiter: ";" });
    const rows = parseCsv(semi, ";");
    expect(rows[0]).toEqual(FOLDED_COLUMNS);
    // `kinds` is itself `;`-joined, so with a `;` delimiter it must be quoted.
    expect(semi).toContain('"invocation;reference"');
  });

  it("quotes fields containing the delimiter, a quote or a newline", () => {
    const folded = makeFolded(
      [foldedNode(ADVERSARIAL_IDS.quote), foldedNode(ADVERSARIAL_IDS.newline)],
      [
        foldedEdge(ADVERSARIAL_IDS.quote, ADVERSARIAL_IDS.newline, { count: 3 }),
        foldedEdge(ADVERSARIAL_IDS.signature, ADVERSARIAL_IDS.backslash),
      ],
    );
    const csv = foldedGraphToCsv(folded);
    const rows = parseCsv(csv).slice(1);
    // The parser recovered the ids exactly — quoting was reversible.
    expect(rows.map((row) => row[0])).toContain(ADVERSARIAL_IDS.quote);
    expect(rows.map((row) => row[1])).toContain(ADVERSARIAL_IDS.newline);
    // A comma inside a Java signature must not become a field boundary.
    const signature = rows.find((row) => row[0]?.includes("#pay("));
    expect(signature?.[0]).toBe(ADVERSARIAL_IDS.signature);
    expect(csv).toContain('""hi""'); // the inner quote was doubled
  });
});

describe("couplingToCsv", () => {
  const table = couplingTable(
    [
      couplingRow("java:a/A", { fanOut: 2, fanIn: 1, outgoingEdgeCount: 9, incomingEdgeCount: 3 }),
      couplingRow("java:b/B", { fanOut: 0, fanIn: 0, isStub: true, name: undefined }),
      couplingRow(ADVERSARIAL_IDS.signature, { fanOut: 1, fanIn: 0, name: 'pay("x")' }),
    ],
    "type",
  );

  it("renders the documented columns plus the view and level", () => {
    const rows = parseCsv(couplingToCsv(table));
    expect(rows[0]).toEqual([
      "id",
      "name",
      "isStub",
      "fanIn",
      "fanOut",
      "ca",
      "ce",
      "instability",
      "incomingEdgeCount",
      "outgoingEdgeCount",
      "level",
      "view",
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual([
      "java:a/A",
      "java:a/A",
      "false",
      "1",
      "2",
      "1",
      "2",
      String(2 / 3),
      "3",
      "9",
      "type",
      "all",
    ]);
  });

  it("renders an absent name as an empty field, never as `undefined`", () => {
    const rows = parseCsv(couplingToCsv(table));
    expect(rows[2]?.[1]).toBe("");
    expect(couplingToCsv(table)).not.toContain("undefined");
  });

  it("survives a name containing quotes and a signature containing commas", () => {
    const rows = parseCsv(couplingToCsv(table)).slice(1);
    const row = rows.find((fields) => fields[0] === ADVERSARIAL_IDS.signature);
    expect(row).toBeDefined();
    expect(row?.[1]).toBe('pay("x")');
    expect(row?.[10]).toBe("type");
  });

  it("keeps an undefined instability out of the table by construction", () => {
    // Ca + Ce === 0 is 0, not NaN — a NaN here would poison every sort.
    const rows = parseCsv(couplingToCsv(table));
    expect(rows[2]?.[7]).toBe("0");
  });

  it("is byte-identical across runs", () => {
    expect(couplingToCsv(table)).toBe(couplingToCsv(table));
  });
});

describe("cyclesToCsv", () => {
  const report = cycleReport(
    [scc(["java:a/A", "java:b/B"], 3, 11), scc(["java:c/C", "java:d/D", "java:e/E"], 4, 4)],
    ["java:f/F", ADVERSARIAL_IDS.quote],
    "module",
  );

  it("flattens to one row per member, keyed by component", () => {
    const rows = parseCsv(cyclesToCsv(report));
    expect(rows[0]).toEqual([
      "component",
      "size",
      "weight",
      "member",
      "internalEdgeCount",
      "level",
      "view",
    ]);
    expect(rows).toHaveLength(1 + 2 + 3 + 2);
    expect(rows[1]).toEqual(["scc:0", "2", "11", "java:a/A", "3", "module", "all"]);
    expect(rows[3]).toEqual(["scc:1", "3", "4", "java:c/C", "4", "module", "all"]);
  });

  it("reports self-loops rather than dropping them, with unknown fields empty", () => {
    const rows = parseCsv(cyclesToCsv(report)).slice(1);
    const loops = rows.filter((row) => row[0] === "selfLoop");
    expect(loops).toHaveLength(2);
    expect(loops[0]).toEqual(["selfLoop", "1", "", "java:f/F", "", "module", "all"]);
    // An empty field, not a fabricated 0: the report does not carry the weight.
    expect(loops[1]?.[3]).toBe(ADVERSARIAL_IDS.quote);
  });

  it("renders an empty report as a bare header", () => {
    expect(cyclesToCsv(cycleReport([], []))).toBe(
      "component,size,weight,member,internalEdgeCount,level,view\n",
    );
    expect(cyclesToCsv(cycleReport([], []), { header: false })).toBe("");
  });

  it("is byte-identical across runs", () => {
    expect(cyclesToCsv(report)).toBe(cyclesToCsv(report));
  });
});
