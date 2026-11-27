import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Edge, type Entity, type Model } from "@codegraph/core";
import { HOTSPOT_FAMILIES } from "@codegraph/analyzer";
import { HISTORY_SCHEMA_VERSION, encodeHistoryToString, type History } from "@codegraph/scm";

import { HISTORY_SPEC } from "../src/args.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `history --report hotspots --model FILE` and `history --report summary
 * --model FILE` (M23b, PLAN §24.5): the join the discovery walk's third step
 * asked a spreadsheet for. End to end, on one hand-counted story.
 *
 * The model, extracted from `src/`:
 *
 *   com/x/order/Order.java     40 lines · cyclomatic 6 + 2 (a lambda) + 1 = 9
 *   com/x/order/Pricing.java   20 lines · cyclomatic 9
 *   com/x/stock/Stock.java     30 lines · cyclomatic 4
 *   com/x/App.java              5 lines · cyclomatic 1
 *   gen/Dto.java               measured by nothing, touched by no commit
 *   declared:  Order <-> Pricing (a cycle)   Order -> Stock   App -> Order
 *
 * The history, eight commits:
 *
 *   c0 FIX  Order Pricing        c4      Stock App
 *   c1      Order Stock          c5      README
 *   c2 FIX  Order                c6      Stock
 *   c3 FIX  Pricing              c7      Order Pricing
 *
 *              revisions  fixes   classic  branchy  tangled  fragile
 *   Order          4        2     160 #1    36 #1    4 #1     2 #1
 *   Pricing        3        2      60 #3    27 #2    3 #2     2 #2
 *   Stock          3        0      90 #2    12 #3    -        -
 *   App            1        0       5 #4     1 #4    -        -
 *
 * Seven commits touch the model; c1 (order + stock) and c4 (stock + the root)
 * cross a top-level directory: 2 of 7.
 *
 * Every change adds 2 lines. Alice makes c0..c6, one a day from 1970-01-01;
 * Bob makes c7. So Alice wrote 6 of Order's 8 added lines (75%) and 4 of
 * Pricing's 6 (67%), all of Stock's and App's, and was last seen on 01-07.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-joined-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MODEL_FILE = {
  order: "com/x/order/Order.java",
  pricing: "com/x/order/Pricing.java",
  stock: "com/x/stock/Stock.java",
  app: "com/x/App.java",
  dto: "gen/Dto.java",
} as const;
const HIST = {
  order: `src/${MODEL_FILE.order}`,
  pricing: `src/${MODEL_FILE.pricing}`,
  stock: `src/${MODEL_FILE.stock}`,
  app: `src/${MODEL_FILE.app}`,
  readme: "README.md",
} as const;

function historyFile(): string {
  const paths: string[] = Object.values(HIST).slice().sort();
  const commits: { files: string[]; fix: boolean }[] = [
    { files: [HIST.order, HIST.pricing], fix: true },
    { files: [HIST.order, HIST.stock], fix: false },
    { files: [HIST.order], fix: true },
    { files: [HIST.pricing], fix: true },
    { files: [HIST.stock, HIST.app], fix: false },
    { files: [HIST.readme], fix: false },
    { files: [HIST.stock], fix: false },
    { files: [HIST.order, HIST.pricing], fix: false },
  ];
  const history: History = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    scm: "git",
    miner: "codegraph-scm@test",
    repo: "demo",
    authors: ["Alice <a@x>", "Bob <b@x>"],
    paths,
    commits: commits.map((commit, index) => ({
      hash: index.toString(16).padStart(40, "0"),
      // Bob makes the last commit; Alice's last one is c6, on the seventh day.
      author: index === 7 ? 1 : 0,
      time: index * 86_400,
      isFix: commit.fix,
      isRevert: false,
    })),
    changes: commits.flatMap((commit, index) =>
      commit.files
        .map((file) => paths.indexOf(file))
        .sort((x, y) => x - y)
        .map((path) => ({ commit: index, path, added: 2, deleted: 1 })),
    ),
  };
  const path = join(scratch, "demo-history.jsonl");
  writeFileSync(path, encodeHistoryToString(history), "utf8");
  return path;
}

const id = (module: string, symbol: string): string => renderId({ lang: "java", module, symbol });

function modelFile(): string {
  const pkg = (module: string): Entity =>
    ({ id: id(module, ""), kind: "package", traits: ["TNamed", "TModule", "TWithChildren"], name: module, definedIn: [], isStub: false }) as unknown as Entity;
  const type = (module: string, name: string, file: string, sloc?: number): Entity =>
    ({
      id: id(module, name),
      kind: "class",
      traits: [
        "TNamed", "TType", "TWithInheritances", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor",
        ...(sloc === undefined ? [] : ["TMetrics"]),
      ],
      name,
      isStub: false,
      parent: id(module, ""),
      anchor: { file, span: [1, 40] },
      ...(sloc === undefined ? {} : { metrics: { sloc } }),
    }) as unknown as Entity;
  const method = (module: string, symbol: string, parent: string, file: string, cyclomatic: number, kind = "method"): Entity =>
    ({
      id: id(module, symbol),
      kind,
      traits: ["TNamed", "TInvocable", "TChildOf", "TSourceAnchor", "TMetrics"],
      name: symbol,
      signature: "()",
      isStub: false,
      parent: id(module, parent),
      anchor: { file, span: [2, 4] },
      metrics: { cyclomatic, sloc: 3 },
    }) as unknown as Entity;
  const edge = (from: string, to: string, file: string): Edge =>
    ({ edge: "reference", from, to, provenance: "declared", anchor: { file, span: [3, 3] } }) as unknown as Edge;

  const model = {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo/src",
    entities: [
      pkg("com.x"),
      pkg("com.x.order"),
      pkg("com.x.stock"),
      pkg("gen"),
      type("com.x.order", "Order", MODEL_FILE.order, 40),
      method("com.x.order", "Order.place()", "Order", MODEL_FILE.order, 6),
      method("com.x.order", "Order.place().lambda", "Order.place()", MODEL_FILE.order, 2, "lambda"),
      method("com.x.order", "Order.total()", "Order", MODEL_FILE.order, 1),
      type("com.x.order", "Pricing", MODEL_FILE.pricing, 20),
      method("com.x.order", "Pricing.price()", "Pricing", MODEL_FILE.pricing, 9),
      type("com.x.stock", "Stock", MODEL_FILE.stock, 30),
      method("com.x.stock", "Stock.reserve()", "Stock", MODEL_FILE.stock, 4),
      type("com.x", "App", MODEL_FILE.app, 5),
      method("com.x", "App.main()", "App", MODEL_FILE.app, 1),
      type("gen", "Dto", MODEL_FILE.dto),
    ],
    edges: [
      edge(id("com.x.order", "Order.place()"), id("com.x.order", "Pricing"), MODEL_FILE.order),
      edge(id("com.x.order", "Pricing.price()"), id("com.x.order", "Order"), MODEL_FILE.pricing),
      edge(id("com.x.order", "Order"), id("com.x.stock", "Stock"), MODEL_FILE.order),
      edge(id("com.x", "App.main()"), id("com.x.order", "Order"), MODEL_FILE.app),
    ],
  } as unknown as Model;
  const path = join(scratch, "demo-model.jsonl");
  writeFileSync(path, encodeModelToString(model), "utf8");
  return path;
}

const HISTORY_PATH = historyFile();
const MODEL_PATH = modelFile();

function invoke(argv: readonly string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = runSync(argv, io);
  return { io, code };
}

interface JoinedRow {
  path: string;
  model: string;
  revisions: number;
  fixes: number;
  bugDensity: number;
  sloc: number | null;
  cyclomatic: number | null;
  cycle: number;
  scores: Record<string, number>;
  ranks: Record<string, number | null>;
}
interface JoinedJson {
  report: string;
  rank: string;
  total: number;
  outsideModel: number;
  outsideHistory: number;
  rows: JoinedRow[];
}

describe("history --report hotspots --model: the joined report", () => {
  const joined = (extra: readonly string[] = []): { io: CapturedIo; code: number; json: JoinedJson } => {
    const result = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--model", MODEL_PATH, "--json", ...extra]);
    return { ...result, json: JSON.parse(result.io.stdout()) as JoinedJson };
  };

  it("ranks the four joined files, branchy first, and says what did not join", () => {
    const { code, json, io } = joined();
    expect(code).toBe(EXIT.OK);
    expect(json).toMatchObject({ report: "hotspots", rank: "branchy", total: 4, outsideModel: 1, outsideHistory: 1 });
    expect(json.rows.map((row) => row.path)).toEqual([HIST.order, HIST.pricing, HIST.stock, HIST.app]);
    expect(io.stderr()).toContain("1 of 5 history files has no counterpart in the model");
    expect(io.stderr()).toContain("1 model file was touched by no mined commit");
  });

  it("counts Order by hand: both sides, the four scores, the four ranks", () => {
    expect(joined().json.rows[0]).toEqual({
      path: HIST.order,
      model: MODEL_FILE.order,
      revisions: 4,
      added: 8,
      deleted: 4,
      churn: 12,
      fixes: 2,
      bugDensity: 0.5,
      authors: 2,
      ownerShare: 0.75,
      ownerLastSeen: "1970-01-07",
      ownerRank: 1,
      sloc: 40,
      cyclomatic: 9,
      cycle: 2,
      scores: { classic: 160, branchy: 36, tangled: 4, fragile: 2 },
      ranks: { classic: 1, branchy: 1, tangled: 1, fragile: 1 },
    });
  });

  it("ranks each family on its own: Stock is second by size, third by branching, absent from the last two", () => {
    const stock = joined().json.rows.find((row) => row.path === HIST.stock)!;
    expect(stock.scores).toEqual({ classic: 90, branchy: 12, tangled: 0, fragile: 0 });
    expect(stock.ranks).toEqual({ classic: 2, branchy: 3, tangled: null, fragile: null });
  });

  it.each([
    ["classic", [HIST.order, HIST.stock, HIST.pricing, HIST.app]],
    ["branchy", [HIST.order, HIST.pricing, HIST.stock, HIST.app]],
    ["tangled", [HIST.order, HIST.pricing, HIST.stock, HIST.app]],
    ["fragile", [HIST.order, HIST.pricing, HIST.stock, HIST.app]],
  ] as const)("--rank %s orders the rows by that family", (rank, order) => {
    const { json } = joined(["--rank", rank]);
    expect(json.rank).toBe(rank);
    expect(json.rows.map((row) => row.path)).toEqual(order);
  });

  it("says who holds each file as a share and a date, never as a name", () => {
    const { io, json } = joined();
    expect(json.rows.map((row) => [(row as unknown as { ownerShare: number }).ownerShare, (row as unknown as { ownerLastSeen: string }).ownerLastSeen])).toEqual([
      [0.75, "1970-01-07"],
      [4 / 6, "1970-01-07"],
      [1, "1970-01-07"],
      [1, "1970-01-07"],
    ]);
    // Alice has 7 commits, Bob 1: she is row 1 of `--report authors`, and every file here is hers.
    expect(json.rows.map((row) => (row as unknown as { ownerRank: number }).ownerRank)).toEqual([1, 1, 1, 1]);
    const authors = JSON.parse(invoke(["history", HISTORY_PATH, "--report", "authors", "--json"]).io.stdout()) as { rows: { author: string }[] };
    expect(authors.rows[0]!.author).toBe("Alice <a@x>");
    const text = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--model", MODEL_PATH]).io;
    for (const out of [io.stdout(), io.stderr(), text.stdout(), text.stderr()]) {
      expect(out).not.toContain("Alice");
      expect(out).not.toContain("Bob");
    }
  });

  it("--top cuts the rows and keeps the total and every rank", () => {
    const { json } = joined(["--rank", "classic", "--top", "2"]);
    expect(json.total).toBe(4);
    expect(json.rows.map((row) => [row.path, row.ranks["classic"]])).toEqual([
      [HIST.order, 1],
      [HIST.stock, 2],
    ]);
  });

  it("prints a table a person can read, the ranks as columns and a legend under it", () => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--model", MODEL_PATH]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout().split("\n").filter((line) => line !== "")).toEqual([
      "hotspots of demo, joined with the model (top 4 of 4 files, by branchy rank):",
      "  REVISIONS  SLOC  CYCLOMATIC  CYCLE  FIXES  DENSITY  AUTHORS    OWNER  CLASSIC  BRANCHY  TANGLED  FRAGILE  PATH",
      "          4    40           9      2      2     0.50        2   75% #1        1        1        1        1  src/com/x/order/Order.java",
      "          3    20           9      2      2     0.67        2   67% #1        3        2        2        2  src/com/x/order/Pricing.java",
      "          3    30           4      0      0     0.00        1  100% #1        2        3        -        -  src/com/x/stock/Stock.java",
      "          1     5           1      0      0     0.00        1  100% #1        4        4        -        -  src/com/x/App.java",
      "ranks: classic = revisions x sloc, branchy = revisions x cyclomatic, tangled = revisions of a file in a dependency cycle (CYCLE = its files), fragile = revisions x density = fixes; - = not ranked. OWNER = the share of the file's added lines its main author wrote, and that author's row in --report authors.",
    ]);
  });

  it("without --model it is the history's own report, unchanged", () => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { total: number; rank?: string; rows: Record<string, unknown>[] };
    expect(parsed.total).toBe(5);
    expect(parsed.rank).toBeUndefined();
    expect(parsed.rows[0]).toEqual({ path: HIST.order, revisions: 4, added: 8, deleted: 4, churn: 12, fixes: 2, bugDensity: 0.5, authors: 2 });
  });

  it("refuses --rank where there is nothing to rank by", () => {
    const noModel = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--rank", "classic"]);
    expect(noModel.code).toBe(EXIT.USAGE);
    expect(noModel.io.stderr()).toContain("--model");
    const otherReport = invoke(["history", HISTORY_PATH, "--report", "authors", "--model", MODEL_PATH, "--rank", "classic"]);
    expect(otherReport.code).toBe(EXIT.USAGE);
    expect(otherReport.io.stderr()).toContain("--report hotspots");
    const unknown = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--model", MODEL_PATH, "--rank", "biggest"]);
    expect(unknown.code).toBe(EXIT.USAGE);
  });

  it("a model that cannot be read is a usage error naming --model", () => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", "hotspots", "--model", join(scratch, "nowhere.jsonl")]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--model");
    expect(io.stdout()).toBe("");
  });

  it("offers the analyzer's four families, and no other, as --rank", () => {
    const rank = HISTORY_SPEC.options.find((option) => option.name === "rank");
    expect(rank?.choices).toEqual(HOTSPOT_FAMILIES);
  });
});

describe("a --model that is not a model", () => {
  /**
   * Found while writing this file: a model with one invalid line loaded as an
   * EMPTY union, the join matched nothing, and `hidden` printed "none — every
   * co-changed pair is explained by a declared dependency path". A report over
   * nothing is not a report: the file is the finding, as for every model command.
   */
  const broken = join(scratch, "broken-model.jsonl");
  writeFileSync(broken, '{"t":"header","schemaVersion":"1.0.0"}\n', "utf8");

  it.each(["hotspots", "summary", "hidden", "deadweight"])("%s: exit 3, the reason on stderr, nothing on stdout", (report) => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", report, "--model", broken]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("is not a model");
    expect(io.stderr()).toContain("codegraph validate");
  });
});

describe("history --report summary --model: how often a commit crosses a module", () => {
  it("counts by hand: 2 of the 7 commits that touch the model", () => {
    const { io, code } = invoke(["history", HISTORY_PATH, "--report", "summary", "--model", MODEL_PATH, "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as { commits: number; crossModule: Record<string, unknown> };
    expect(parsed.commits).toBe(8);
    expect(parsed.crossModule).toEqual({
      root: "com/x",
      modules: [".", "order", "stock"],
      commits: 7,
      crossing: 2,
      share: 2 / 7,
      skipped: 0,
    });
  });

  it("adds one line to the text, after the history's own", () => {
    const { io } = invoke(["history", HISTORY_PATH, "--report", "summary", "--model", MODEL_PATH]);
    const lines = io.stdout().split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("history of demo: 8 commits by 2 authors over 5 files");
    expect(lines.at(-1)).toBe("  cross-module: 2 of 7 commits touching the model cross its top-level directories (28.6%; 3 under com/x)");
  });

  it("says nothing of modules without a model", () => {
    const { io } = invoke(["history", HISTORY_PATH, "--report", "summary", "--json"]);
    expect(JSON.parse(io.stdout())).not.toHaveProperty("crossModule");
    expect(invoke(["history", HISTORY_PATH, "--report", "summary"]).io.stdout()).not.toContain("cross-module");
  });
});
