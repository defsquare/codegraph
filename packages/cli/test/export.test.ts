import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExportOptions, FormatName } from "../src/args.js";
import { exportCommand } from "../src/commands/export.js";
import { encodeModelToString, parseModel } from "@codegraph/core";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo, processIo, type CapturedIo, type IoSink } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * The real Spoon output: 166 entities / 173 edges, a clean bill of health.
 * Folded, it is 10 nodes / 14 edges at module level (5 base edges unplaceable)
 * and 36 nodes / 71 edges at type level (10 unplaceable). Those numbers are
 * MEASURED FACTS about the fixture, so the assertions below name them rather
 * than re-deriving them from the same code under test.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

const MODULE_NODES = 10;
const MODULE_EDGES = 14;
const TYPE_NODES = 36;
const TYPE_EDGES = 74;

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    models: [FIXTURE],
    format: "dot",
    level: "module",
    internalOnly: false,
    declaredOnly: false,
    out: undefined,
    noCache: true,
    ...overrides,
  };
}

function exportTo(overrides: Partial<ExportOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = exportCommand(options(overrides), io);
  return { io, code };
}

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-export-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/**
 * A structural DOT check, because graphviz is not installed here. It does not
 * lay a graph out; it answers the only questions a corrupted render would fail:
 * are the braces balanced, is every quoted string closed, does a raw newline
 * ever appear inside one (it must not — `escapeDot` turns it into `\n`), and
 * how many statements and edges are outside the strings.
 *
 * Comments and quoted strings are skipped exactly as dot(1) would skip them,
 * so a `{`, a `;` or a `->` INSIDE an entity id can never be miscounted — which
 * is the whole reason ids get quoted in the first place.
 */
interface DotScan {
  readonly balanced: boolean;
  readonly unterminatedString: boolean;
  readonly rawNewlineInString: boolean;
  readonly statements: number;
  readonly edges: number;
  readonly maxDepth: number;
}

function scanDot(text: string): DotScan {
  let depth = 0;
  let maxDepth = 0;
  let wentNegative = false;
  let inString = false;
  let inComment = false;
  let rawNewlineInString = false;
  let statements = 0;
  let edges = 0;

  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);

    if (inComment) {
      if (character === "\n") inComment = false;
      continue;
    }

    if (inString) {
      // A backslash escapes the next character, so `\"` never closes a string.
      if (character === "\\") {
        i += 1;
        continue;
      }
      if (character === '"') inString = false;
      else if (character === "\n") rawNewlineInString = true;
      continue;
    }

    if (character === "/" && text.charAt(i + 1) === "/") {
      inComment = true;
      i += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) wentNegative = true;
    } else if (character === ";") {
      statements += 1;
    } else if (character === "-" && text.charAt(i + 1) === ">") {
      edges += 1;
      i += 1;
    }
  }

  return {
    balanced: depth === 0 && !wentNegative,
    unterminatedString: inString,
    rawNewlineInString,
    statements,
    edges,
    maxDepth,
  };
}

/**
 * An RFC 4180 parser: fields split on the delimiter, `"` quotes a field, `""`
 * is a literal quote inside one, LF ends a record. Written here on purpose —
 * checking the CSV with the same escaping code that produced it would prove
 * nothing about whether a third-party importer can read it.
 */
function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let open = false; // a field has been started on this record

  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);

    if (quoted) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (character === '"' && field === "") {
      quoted = true;
      open = true;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      open = true;
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      open = false;
      continue;
    }
    field += character;
    open = true;
  }

  if (open || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("export: stream purity (decision 3)", () => {
  it("puts the DOT and nothing else on stdout", () => {
    const { io, code } = exportTo({ format: "dot" });

    expect(code).toBe(EXIT.OK);
    // The very first character of stdout is the artifact's own first character.
    expect(io.stdout().startsWith("// codegraph")).toBe(true);
    expect(io.stdout().trimEnd().endsWith("}")).toBe(true);
    expect(io.stdout()).not.toContain("warning");
    expect(io.stdout()).not.toContain("wrote ");
    // `> graph.dot` keeps exactly this and nothing more.
    expect(scanDot(io.stdout()).balanced).toBe(true);
  });

  it("puts the CSV header first, with no banner above it", () => {
    const { io } = exportTo({ format: "csv" });
    expect(io.stdout().startsWith("from,to,count,")).toBe(true);
    expect(io.stdout()).not.toContain("warning");
  });

  it("puts the JSON object first, with no prose above it", () => {
    const { io } = exportTo({ format: "json" });
    expect(io.stdout().startsWith("{")).toBe(true);
    expect(io.stdout()).not.toContain("warning");
  });

  it("keeps no ANSI escape anywhere (decision 4)", () => {
    const { io } = exportTo({ format: "dot" });
    // eslint-disable-next-line no-control-regex
    const ansi = /\u001B\[/;
    expect(ansi.test(io.stdout())).toBe(false);
    expect(ansi.test(io.stderr())).toBe(false);
  });

  it("reports the folding losses on stderr, where they cannot corrupt the artifact", () => {
    const { io } = exportTo({ format: "dot", level: "module" });
    // 5 base edges are unplaceable at module level on this fixture: a silently
    // smaller graph is how a wrong number gets trusted.
    expect(io.stderr()).toContain("5 base edges dropped");
    expect(io.stderr()).toContain("module level");
  });
});

describe("export: DOT", () => {
  it("is structurally sound at module level", () => {
    const scan = scanDot(exportTo({ format: "dot", level: "module" }).io.stdout());
    expect(scan.balanced).toBe(true);
    expect(scan.unterminatedString).toBe(false);
    expect(scan.rawNewlineInString).toBe(false);
    // digraph + the legend cluster.
    expect(scan.maxDepth).toBe(2);
    // Every folded edge, plus the legend's two example edges.
    expect(scan.edges).toBe(MODULE_EDGES + 2);
  });

  it("is structurally sound at type level", () => {
    const scan = scanDot(exportTo({ format: "dot", level: "type" }).io.stdout());
    expect(scan.balanced).toBe(true);
    expect(scan.unterminatedString).toBe(false);
    expect(scan.rawNewlineInString).toBe(false);
    expect(scan.edges).toBe(TYPE_EDGES + 2);
  });

  it("declares one node statement per folded node", () => {
    const dot = exportTo({ format: "dot", level: "module" }).io.stdout();
    // graph/node/edge defaults + nodes + edges + the legend's own statements.
    const scan = scanDot(dot);
    expect(scan.statements).toBeGreaterThanOrEqual(MODULE_NODES + MODULE_EDGES);
    expect(dot).toContain("// level: module");
    expect(dot).toContain("digraph");
  });

  it("says in the file itself that it is not a model.jsonl", () => {
    expect(exportTo({ format: "dot" }).io.stdout()).toContain("Not a model.jsonl");
  });
});

describe("export: CSV", () => {
  it("round-trips through an RFC 4180 parser at module level", () => {
    const rows = parseCsv(exportTo({ format: "csv", level: "module" }).io.stdout());
    expect(rows[0]).toEqual([
      "from",
      "to",
      "count",
      "kinds",
      "provenances",
      "selfLoop",
      "level",
      "view",
    ]);
    expect(rows.length).toBe(MODULE_EDGES + 1);
    for (const row of rows) expect(row.length).toBe(8);
  });

  it("round-trips through an RFC 4180 parser at type level", () => {
    const rows = parseCsv(exportTo({ format: "csv", level: "type" }).io.stdout());
    expect(rows.length).toBe(TYPE_EDGES + 1);
    for (const row of rows) expect(row.length).toBe(8);
  });

  it("carries the level and the view in every row, not in a comment", () => {
    const rows = parseCsv(exportTo({ format: "csv", level: "type", internalOnly: true }).io.stdout());
    const body = rows.slice(1);
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row[6]).toBe("type");
      expect(row[7]).toContain("internalOnly");
    }
  });

  it("survives a field that itself contains a comma and a quote", () => {
    // Ids are opaque strings; a Java signature id carries `(`, `,` and `<`.
    const rows = parseCsv(exportTo({ format: "csv", level: "type" }).io.stdout());
    const reparsed = rows.slice(1).map((row) => row[0] ?? "");
    // Every parsed `from` field is a whole id — never a fragment ending mid-token.
    for (const id of reparsed) {
      expect(id.length).toBeGreaterThan(0);
      expect(id.startsWith('"')).toBe(false);
    }
  });
});

describe("export: JSON", () => {
  it("parses, and is stamped as an analysis artefact rather than a model", () => {
    const parsed = JSON.parse(exportTo({ format: "json", level: "module" }).io.stdout()) as Record<
      string,
      unknown
    >;
    expect(parsed["kind"]).toBe("codegraph.foldedGraph/1");
    expect(parsed["generatedBy"]).toBe("@codegraph/analyzer");
    // The interchange format's marker must be absent: a file carrying
    // `schemaVersion` claims to be extractor output, and this is not.
    expect("schemaVersion" in parsed).toBe(false);
    expect("entities" in parsed).toBe(false);
  });

  it("carries the folded graph and its diagnostics", () => {
    const parsed = JSON.parse(exportTo({ format: "json", level: "module" }).io.stdout()) as {
      level: string;
      view: { name: string };
      nodes: unknown[];
      edges: unknown[];
      diagnostics: { droppedEdges: number; unfoldableEntities: unknown[] };
    };
    expect(parsed.level).toBe("module");
    expect(parsed.nodes.length).toBe(MODULE_NODES);
    expect(parsed.edges.length).toBe(MODULE_EDGES);
    expect(parsed.diagnostics.droppedEdges).toBe(5);
    expect(parsed.view.name).toBe("all");
  });

  it("keeps type level distinct from module level", () => {
    const parsed = JSON.parse(exportTo({ format: "json", level: "type" }).io.stdout()) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(parsed.nodes.length).toBe(TYPE_NODES);
    expect(parsed.edges.length).toBe(TYPE_EDGES);
  });
});

describe("export: PlantUML", () => {
  it("is a single @startuml/@enduml block with one package per module and one arrow per edge", () => {
    const { io, code } = exportTo({ format: "plantuml", level: "module" });
    expect(code).toBe(EXIT.OK);
    const artifact = io.stdout();
    // Stream purity: the artifact's own first byte opens stdout.
    expect(artifact.startsWith("@startuml")).toBe(true);
    expect(artifact.trimEnd().endsWith("@enduml")).toBe(true);
    expect(artifact).not.toContain("warning");
    const lines = artifact.split("\n");
    expect(lines.filter((line) => line === "@startuml")).toHaveLength(1);
    expect(lines.filter((line) => line === "@enduml")).toHaveLength(1);
    // A module is not a type: at module level the diagram is packages, and a
    // `class` statement would assert a type the model never declared.
    expect(lines.filter((line) => line.startsWith('package "'))).toHaveLength(MODULE_NODES);
    expect(lines.filter((line) => line.startsWith('class "'))).toHaveLength(0);
    // Anchored at column 0: the legend's example arrows are indented.
    expect(lines.filter((line) => /^\w+ (-->|\.\.>) /.test(line))).toHaveLength(MODULE_EDGES);
  });

  it("keeps every statement on one physical line at type level, signature ids included", () => {
    const artifact = exportTo({ format: "plantuml", level: "type" }).io.stdout();
    const lines = artifact.split("\n");
    expect(lines.filter((line) => line.startsWith('class "'))).toHaveLength(TYPE_NODES);
    expect(lines.filter((line) => line.startsWith('package "'))).toHaveLength(0);
    // A raw newline in a label would orphan a fragment that matches no grammar.
    for (const line of lines) {
      expect(
        /^(@startuml|@enduml|'|title |hide |class "|package "|\}$|legend$|end legend$| |[A-Za-z_])/.test(line) ||
          line === "",
      ).toBe(true);
    }
    expect(lines.filter((line) => /^\w+ (-->|\.\.>) /.test(line))).toHaveLength(TYPE_EDGES);
  });

  it("carries the level and the view into the rendered title", () => {
    const artifact = exportTo({ format: "plantuml", level: "module", internalOnly: true }).io.stdout();
    const title = artifact.split("\n").find((line) => line.startsWith("title "));
    expect(title).toContain("module");
    expect(title).toContain("internalOnly");
  });

  it("says in the file itself that it is not a model.jsonl", () => {
    expect(exportTo({ format: "plantuml" }).io.stdout()).toContain("Not a model.jsonl");
  });
});

describe("export: determinism (decision 6)", () => {
  const formats: readonly FormatName[] = ["dot", "json", "csv", "plantuml"];

  for (const format of formats) {
    it(`produces byte-identical ${format} on two runs`, () => {
      const first = exportTo({ format, level: "type" }).io.stdout();
      const second = exportTo({ format, level: "type" }).io.stdout();
      expect(second).toBe(first);
      expect(second.length).toBeGreaterThan(0);
    });
  }
});

describe("export: views", () => {
  it("--internal-only genuinely changes the artifact", () => {
    const all = exportTo({ format: "json", level: "type" }).io.stdout();
    const internal = exportTo({ format: "json", level: "type", internalOnly: true }).io.stdout();
    expect(internal).not.toBe(all);

    const parseIt = (text: string): { nodes: { isStub: boolean }[]; view: { name: string } } =>
      JSON.parse(text) as { nodes: { isStub: boolean }[]; view: { name: string } };
    const before = parseIt(all);
    const after = parseIt(internal);

    expect(before.nodes.some((node) => node.isStub)).toBe(true);
    expect(after.nodes.some((node) => node.isStub)).toBe(false);
    expect(after.nodes.length).toBeLessThan(before.nodes.length);
    expect(after.view.name).toContain("internalOnly");
  });

  it("--declared-only names itself in the view descriptor the artifact carries", () => {
    const dot = exportTo({ format: "dot", declaredOnly: true }).io.stdout();
    expect(dot).toContain("// view: declaredOnly");
  });

  it("composes both view flags in one descriptor", () => {
    const parsed = JSON.parse(
      exportTo({ format: "json", internalOnly: true, declaredOnly: true }).io.stdout(),
    ) as { view: { name: string } };
    expect(parsed.view.name).toContain("internalOnly");
    expect(parsed.view.name).toContain("declaredOnly");
  });
});

describe("export: --out FILE", () => {
  it("writes the artifact to the file and leaves stdout empty", () => {
    const io = captureIo();
    const code = exportCommand(options({ format: "dot", out: "graph.dot" }), io);

    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.files().get("graph.dot")).toBeDefined();
    expect(scanDot(io.files().get("graph.dot") ?? "").balanced).toBe(true);
  });

  it("confirms on STDERR, never on stdout", () => {
    const io = captureIo();
    exportCommand(options({ format: "csv", out: "graph.csv" }), io);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("graph.csv");
    expect(io.stderr()).toContain("bytes");
  });

  it("writes the same bytes it would have put on stdout", () => {
    const piped = exportTo({ format: "json", level: "type" }).io.stdout();
    const io = captureIo();
    exportCommand(options({ format: "json", level: "type", out: "graph.json" }), io);
    expect(io.files().get("graph.json")).toBe(piped);
  });

  it("goes through the sink, so the command itself never touches fs", () => {
    const io = captureIo();
    // A path no process could write to would throw if `fs` were called directly.
    exportCommand(options({ format: "dot", out: "/proc/definitely/not/writable.dot" }), io);
    expect(io.files().get("/proc/definitely/not/writable.dot")).toBeDefined();
  });
});

describe("export: --out through the real sink", () => {
  /**
   * The capture proves the command routes `--out` through the sink; this proves
   * the sink then puts the same bytes on a real filesystem, and that a missing
   * parent directory is a usage error rather than a directory tree the command
   * invented. Only `writeFile` is real — `out`/`err` would reach the runner's
   * own streams and pollute the test output.
   */
  function fileSink(): IoSink {
    const real = processIo();
    return {
      out: () => undefined,
      err: () => undefined,
      writeFile: (path, text) => real.writeFile(path, text),
    };
  }

  it("writes the artifact to a real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-out-"));
    const path = join(dir, "graph.dot");

    expect(exportCommand(options({ format: "dot", out: path }), fileSink())).toBe(EXIT.OK);
    const written = readFileSync(path, "utf8");
    expect(scanDot(written).balanced).toBe(true);
    expect(written.startsWith("// codegraph")).toBe(true);
  });

  it("creates no parent directories: a missing one is a usage error (exit 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegraph-cli-out-"));
    let thrown: unknown;
    try {
      exportCommand(options({ format: "dot", out: join(dir, "missing", "graph.dot") }), fileSink());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).exitCode).toBe(EXIT.USAGE);
    expect((thrown as UsageError).message).toContain("cannot write");
  });
});

describe("export: exit codes", () => {
  it("returns FINDINGS for a model that breaks its profile, and exports anyway", () => {
    const model = {
      schemaVersion: "1.0.0",
      lang: "java",
      extractor: { name: "test", version: "0.0.0" },
      root: "/tmp/corpus",
      // The module entity is required by the ENCODING (every entity names its
      // module by reference); the class is still profile-invalid, which is the
      // finding this test is about.
      entities: [
        { id: "java:x", kind: "package", traits: ["TNamed", "TModule"], name: "x", definedIn: [], isStub: false },
        { id: "java:x/Y", kind: "class", traits: ["TNamed"], name: "Y" },
      ],
      edges: [],
    };
    const path = tempFile("invalid-profile.jsonl", encodeModelToString(parseModel(model)));
    const io = captureIo();
    const code = exportCommand(options({ models: [path], format: "dot" }), io);

    expect(code).toBe(EXIT.FINDINGS);
    expect(scanDot(io.stdout()).balanced).toBe(true);
    expect(io.stderr()).toContain("not clean");
    expect(io.stderr()).toContain("profile issue");
    // The artifact is still pure: the warning went to the other stream.
    expect(io.stdout()).not.toContain("not clean");
  });

  it("returns FINDINGS for a file that is not JSON, without dying on it", () => {
    const broken = tempFile("broken.json", "{ nope");
    const io = captureIo();
    const code = exportCommand(options({ models: [broken, FIXTURE], format: "json" }), io);

    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("schema error");
    expect(JSON.parse(io.stdout())).toBeTypeOf("object");
  });

  it("exits USAGE when --format is missing, naming the valid formats", () => {
    const io = captureIo();
    const code = run(["export", FIXTURE], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("--format <dot|json|csv|plantuml>");
  });

  it("exits USAGE for an unknown format, naming the valid ones", () => {
    const io = captureIo();
    const code = run(["export", FIXTURE, "--format", "xml"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("invalid value 'xml' for --format");
    expect(io.stderr()).toContain("dot, json, csv");
  });

  it("exits USAGE for an unreadable model path", () => {
    const missing = join(tmpdir(), "codegraph-export-does-not-exist-1234.json");
    const io = captureIo();
    const code = run(["export", missing, "--format", "dot"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(missing);
  });

  it("exits OK through `run` on the clean fixture, with the artifact on stdout", () => {
    const io = captureIo();
    const code = run(["export", FIXTURE, "--format", "dot", "--level", "type"], io);
    expect(code).toBe(EXIT.OK);
    expect(scanDot(io.stdout()).edges).toBe(TYPE_EDGES + 2);
  });

  it("loads several models as ONE union (decision 5)", () => {
    const io = captureIo();
    // The same model twice: every id is redeclared identically, which the
    // analyzer treats as benign (TS declaration merging, C# partials), so the
    // union stays clean and the folded graph is still one graph.
    const code = exportCommand(options({ models: [FIXTURE, FIXTURE], format: "json" }), io);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { nodes: unknown[] };
    expect(parsed.nodes.length).toBe(MODULE_NODES);
  });
});
