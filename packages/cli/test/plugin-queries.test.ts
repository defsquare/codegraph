import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeModelToString,
  getProfile,
  parseRenderedId,
  readModelFileSync,
  renderId,
  type Edge,
  type Entity,
  type Model,
} from "@codegraph/core";
import {
  STORE_OPEN_OPTIONS,
  buildGraph,
  createHelperViews,
  hasTrait,
  importModel,
  loadModels,
  loadSqlite,
  queryStore,
  statementShape,
  type CodeGraph,
  type QueryResult,
  type SqliteDatabase,
} from "@codegraph/analyzer";
import { formatJson } from "../src/commands/query.js";
import { DOCS_ROOT, REPO_ROOT, fences, pageCommandTables, pageSql, queryFiles, readDoc, type QueryFile } from "./plugin-support.js";

/**
 * THE PAGES AND THE SKILLS RUN THE SAME SQL (PLAN.md §24.4, §24.8).
 *
 * The discovery pages are the method; a step's skill runs the page's queries,
 * from `plugin/queries/*.sql`, through `codegraph query`. Two copies of one
 * statement drift, so each block of a covered page must BE a query file, and
 * each query file must be on its page.
 *
 * Equal text is the floor. What is checked on top is what the first run of
 * this file found missing in the pages as they were: a statement that named
 * Java's kinds returned nothing on Elixir; a sum of every type's lines counted
 * a nested type twice; a table printed under a statement was not that
 * statement's rows. So every query is run on the five fixture stores, through
 * the engine `query` uses; the tables the pages print are the Java fixture's
 * first rows; and the two statements that aggregate are compared with a count
 * made from the model, not from another query.
 */

const LANGUAGES = ["java", "csharp", "typescript", "elixir", "ruby"] as const;
type Language = (typeof LANGUAGES)[number];

const fixture = (lang: string): string => join(REPO_ROOT, "fixtures", lang, "expected", "model.jsonl");

const scratch = mkdtempSync(join(tmpdir(), "codegraph-plugin-queries-"));
const stores = new Map<Language, SqliteDatabase>();
beforeAll(() => {
  for (const lang of LANGUAGES) {
    const path = join(scratch, `${lang}.db`);
    importModel(fixture(lang), path);
    const db = loadSqlite().open(path, { ...STORE_OPEN_OPTIONS, readOnly: true });
    createHelperViews(db);
    stores.set(lang, db);
  }
});
afterAll(() => {
  for (const db of stores.values()) db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const QUERIES = queryFiles();
const query = (name: string): QueryFile => {
  const found = QUERIES.find((file) => file.name === name);
  if (found === undefined) throw new Error(`no plugin/queries/${name}.sql`);
  return found;
};

const PROFILE_OF: Readonly<Record<Language, string>> = { java: "java", csharp: "csharp", typescript: "ts", elixir: "ex", ruby: "rb" };
const profileOf = (lang: Language) => {
  const profile = getProfile(PROFILE_OF[lang]);
  if (profile === undefined) throw new Error(`no profile for ${lang}`);
  return profile;
};

/** The annotation each fixture declares for itself. C# names the attribute's class, suffix included. */
const NAMES: Readonly<Record<Language, string>> = {
  java: '["Audited","Retention"]',
  csharp: '["AuditedAttribute"]',
  typescript: '["Audited"]',
  elixir: '["Audited"]',
  ruby: '["Audited"]',
};

const STIMULI_PAGE = readDoc("discover/stimuli.md");

/**
 * The stack table each fixture is asked with (step 4). Java's is the one the
 * page prints, so the page's tables are this file's rows; the others name
 * what stands for a framework in their fixture, one key per map where the
 * fixture has something for it.
 */
const stack = (lang: Language, maps: Record<string, unknown>): string =>
  JSON.stringify({ annotations: {}, supertypes: {}, types: {}, operations: {}, entries: {}, ...maps, conventional: profileOf(lang).lexicon?.conventional ?? [] });
const STACKS: Readonly<Record<Language, string>> = {
  java: fences(STIMULI_PAGE).find((fence) => fence.lang === "json")!.text,
  csharp: stack("csharp", {
    annotations: { AuditedAttribute: "inbound command" },
    supertypes: { LedgerClient: "external event" },
    types: { "*Service": "inbound command" },
  }),
  typescript: stack("typescript", {
    annotations: { Audited: "inbound query" },
    supertypes: { LedgerClient: "external event" },
    types: { Basket: "inbound command" },
    operations: { ensure: "framework callback" },
  }),
  elixir: stack("elixir", {
    supertypes: { "AcmeOrder.Pricing": "framework callback" },
    types: { "AcmeOrder.Report*": "inbound query" },
    operations: { start: "lifecycle", notify: "internal event" },
  }),
  ruby: stack("ruby", {
    supertypes: { "ActiveRecord::Base": "framework callback" },
    types: { "AcmeOrder::Order": "inbound command" },
    operations: { summary: "inbound query" },
  }),
};

/** Where each fixture's example chain starts; the C# and Ruby ones cross a call that dispatches. */
const REACH_FROM: Readonly<Record<Language, string>> = {
  java: "java:com.acme.order/Order.discount(int)",
  csharp: "csharp:Acme.Order.Extensions/MoneyExtensions.IsFree(Acme.Order.IPriceable)",
  typescript: "ts:packages%2Forder%2Fsrc%2Freporting.ts/ensure",
  elixir: "ex:lib%2Facme_order%2Freporting.ex/AcmeOrder%2EReporting.price_of#1",
  ruby: "rb:lib%2Facme_order%2Forder.rb/AcmeOrder::Order.total",
};

/** The two literals the page passes where step 3's reports would be. */
const PAGE_HOTSPOTS = '{"rows":[{"model":"com/acme/order/Money.java"},{"model":"com/acme/order/OrderService.java"}]}';
const PAGE_ACTIVITY = '{"rows":[{"model":"com/acme/order/Basket.java","revisions":4}]}';
const NO_ROWS = '{"rows":[]}';

/**
 * What each query is asked. Java is asked what the page asks, so its printed
 * tables can be compared; the other languages are asked with the candidates,
 * to run that half of the statements too. A step-4 query reads the SAVED rows
 * of another one (`--param-file`): the text bound here is what `--json` writes.
 */
function paramsFor(name: string, lang: Language): Record<string, string | number> {
  const candidates = lang === "java" ? 0 : 1;
  switch (name) {
    case "annotated-with":
      return { names: NAMES[lang] };
    case "entry-points":
      return { stack: STACKS[lang] };
    case "entry-point-kinds":
      return { inventory: saved("entry-points", lang) };
    case "reach":
      return { id: REACH_FROM[lang], candidates };
    case "chains":
      return { inventory: saved("entry-points", lang), candidates };
    case "chain-ranking":
      return { chains: saved("chains", lang), hotspots: lang === "java" ? PAGE_HOTSPOTS : NO_ROWS };
    case "chain-groups":
      return { chains: saved("chains", lang), min: 50 };
    case "shared-types":
      return { chains: saved("chains", lang) };
    case "residue":
      return { inventory: saved("entry-points", lang), activity: lang === "java" ? PAGE_ACTIVITY : NO_ROWS };
    default:
      return {};
  }
}

const fresh = (name: string, lang: Language): QueryResult =>
  queryStore(stores.get(lang)!, query(name).statement, { params: paramsFor(name, lang) });
const results = new Map<string, QueryResult>();
function result(name: string, lang: Language): QueryResult {
  const key = `${lang}/${name}`;
  let found = results.get(key);
  if (found === undefined) results.set(key, (found = fresh(name, lang)));
  return found;
}
/** A result as `codegraph query --json` writes it: what the next query is handed. */
const saved = (name: string, lang: Language): string => formatJson(result(name, lang));
const run = (file: QueryFile, lang: Language): QueryResult => result(file.name, lang);

/**
 * The queries that read `annotationUse` edges find nothing where the language
 * has no such construct. That is the profile's statement, not this file's: the
 * test below holds the list equal to "the profile has no `annotationUse`".
 */
const READS_ANNOTATIONS = ["annotations", "annotated-with"] as const;
const hasAnnotations = (lang: Language): boolean => (profileOf(lang).edges as readonly string[]).includes("annotationUse");
const emptyByDesign = (name: string, lang: Language): boolean =>
  (READS_ANNOTATIONS as readonly string[]).includes(name) && !hasAnnotations(lang);

/**
 * The pages whose SQL is shipped as query files so far. A page moves here in
 * the milestone that ships its step; until then its blocks are the page's own.
 */
const COVERED = [
  "discover/structure.md",
  "how-to/query-model-db.md",
  "discover/boundaries.md",
  "discover/activity.md",
  "discover/stimuli.md",
] as const;

/** The discovery pages whose steps are not shipped yet, with the milestone that will. */
const PENDING: Readonly<Record<string, string>> = {
  "discover/meaning.md": "M23d",
  "discover/domain.md": "M23d",
};

/** Blocks of a covered page that are NOT a query file, each with the reason. Keyed by the block's first line. */
const PAGE_ONLY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "how-to/query-model-db.md": {
    "CREATE TEMP VIEW node AS": "the node view: the binary's own definition, held by helper-views-docs.test.ts",
    "CREATE TEMP VIEW dep AS": "the dep view: the same",
    "SELECT n.id, count(*) AS fan_in": "an example of the how-to; no step runs it",
    "SELECT d.provenance, d.kind, count(*) AS n": "an example of the how-to; no step runs it",
    "SELECT n.id, max(CASE WHEN em.key = 'cyclomatic' THEN em.value END) AS cc": "an example of the how-to; no step runs it",
  },
};

describe("a query file is a header and one statement that reads", () => {
  it("finds the step's query files", () => {
    expect(QUERIES.map((file) => file.name)).toEqual([
      "annotated-with",
      "annotations",
      "branching-by-type",
      "chain-groups",
      "chain-ranking",
      "chains",
      "entry-point-kinds",
      "entry-points",
      "external-modules",
      "kinds",
      "largest-types",
      "module-reach",
      "reach",
      "residue",
      "shared-types",
      "size-by-module",
      "summary",
      "supertypes",
    ]);
  });

  it.each(QUERIES.map((file) => [file.name, file] as const))("%s.sql: one statement, its parameters declared", (_name, file) => {
    const shape = statementShape(file.statement);
    expect(["SELECT", "WITH"]).toContain(shape.keyword);
    expect(shape.hasTail).toBe(false);
    expect(shape.foreignParams).toEqual([]);
    expect([...shape.params].sort()).toEqual([...file.parameters].sort());
    expect(file.statement.endsWith(";")).toBe(true);
    expect(existsSync(join(DOCS_ROOT, file.page)), `${file.name}.sql names a page that does not exist: ${file.page}`).toBe(true);
  });
});

describe("the pages and the query files hold the same statements", () => {
  it.each(COVERED)("%s: every sql block is a query file, or is listed as the page's own", (page) => {
    const mine = QUERIES.filter((file) => file.page === page);
    const pageOnly = PAGE_ONLY[page] ?? {};
    const unmatched: string[] = [];
    const seen = new Set<string>();
    for (const block of pageSql(readDoc(page))) {
      const file = mine.find((candidate) => candidate.statement === block.sql);
      if (file !== undefined) {
        seen.add(file.name);
        continue;
      }
      const first = block.sql.split("\n")[0]!;
      if (first in pageOnly) {
        seen.add(first);
        continue;
      }
      unmatched.push(`${page}:${block.line} — ${first}`);
    }
    expect(unmatched, "a block that is neither a query file nor listed").toEqual([]);
    expect(mine.filter((file) => !seen.has(file.name)).map((file) => `${file.name}.sql is not on ${page}`)).toEqual([]);
    expect(Object.keys(pageOnly).filter((first) => !seen.has(first)), "a listed block the page no longer has").toEqual([]);
  });

  it("every query file belongs to a covered page", () => {
    expect(QUERIES.filter((file) => !(COVERED as readonly string[]).includes(file.page)).map((file) => file.name)).toEqual([]);
  });

  it("the pages still to cover are the discovery pages, each with its SQL counted", () => {
    // The 18 blocks measured when the plan was written (PLAN.md §24) and the
    // two views, less the one `activity.md` gave up in M23b — a `sqlite3`
    // shell script that fed a spreadsheet, replaced by a command.
    // Restated so a page that gains a query is noticed here.
    const count = (page: string): number => pageSql(readDoc(page)).length;
    expect(Object.fromEntries(Object.keys(PENDING).map((page) => [page, count(page)]))).toEqual({
      "discover/meaning.md": 0,
      "discover/domain.md": 1,
    });
    // `stimuli.md` held 4 blocks; M23c made them 9 query files, at the page's end.
    expect(COVERED.map(count)).toEqual([4, 6, 4, 0, 9]);
  });
});

describe("every query runs on every language, and has something to say", () => {
  it.each(LANGUAGES.flatMap((lang) => QUERIES.map((file) => [lang, file.name] as const)))("%s: %s returns rows", (lang, name) => {
    const result = run(query(name), lang);
    expect(result.columns.length).toBeGreaterThan(0);
    if (emptyByDesign(name, lang)) return expect(result.total, `${lang} has no annotation to find`).toBe(0);
    // Zero rows would be read as "there are none": on a fixture that has
    // types, modules and measured operations, each of these must find some.
    expect(result.total, `${name}.sql found nothing on the ${lang} fixture`).toBeGreaterThan(0);
  });

  it("the languages with nothing to annotate are the ones whose profile says so", () => {
    expect(LANGUAGES.filter((lang) => !hasAnnotations(lang))).toEqual(["elixir", "ruby"]);
  });

  it.each(LANGUAGES)("%s: a ranking is the same on two runs", (lang) => {
    for (const file of QUERIES) expect(fresh(file.name, lang).rows).toEqual(run(file, lang).rows);
  });
});

describe("the tables the pages print are the Java fixture's rows", () => {
  /** A table under a statement, or under the command that runs a query file. */
  const printed = COVERED.flatMap((page) => {
    const markdown = readDoc(page);
    const underStatements = pageSql(markdown)
      .filter((block) => block.table !== undefined)
      .map((block) => ({ page, line: block.line, table: block.table!, file: QUERIES.find((candidate) => candidate.statement === block.sql) }));
    const underCommands = pageCommandTables(markdown).map((shown) => ({
      page,
      line: shown.line,
      table: shown.table,
      file: QUERIES.find((candidate) => candidate.name === shown.file && candidate.page === page),
    }));
    return [...underStatements, ...underCommands].filter((entry): entry is typeof entry & { file: QueryFile } => entry.file !== undefined);
  });

  it("finds a printed table under every shipped statement", () => {
    expect(printed.map((entry) => entry.file.name).sort()).toEqual(QUERIES.map((file) => file.name));
  });

  it.each(printed.map((entry) => [entry.file.name, entry] as const))("%s: the page's rows are the first rows of the result", (_name, entry) => {
    const result = run(entry.file, "java");
    // NULL is written NULL, as the command's own table writes it.
    const rows = result.rows.map((row) => row.map((value) => (value === null ? "NULL" : String(value))));
    expect(entry.table.length).toBeGreaterThan(0);
    expect(entry.table, `${entry.page}:${entry.line}`).toEqual(rows.slice(0, entry.table.length));
  });

  it("asks the fixture what the page's commands ask", () => {
    const commands = pageCommandTables(STIMULI_PAGE);
    const command = (file: string): string => commands.find((shown) => shown.file === file)!.command;
    expect(command("reach")).toContain(`--param id='${REACH_FROM.java}'`);
    expect(command("reach")).toContain("--param candidates=0");
    expect(command("chains")).toContain("--param candidates=0");
    expect(command("chain-ranking")).toContain(`--param hotspots='${PAGE_HOTSPOTS}'`);
    expect(command("chain-groups")).toContain("--param min=50");
    expect(command("residue")).toContain(`--param activity='${PAGE_ACTIVITY}'`);
    for (const [file, name] of [["entry-points", "stack"], ["entry-point-kinds", "inventory"], ["chains", "inventory"], ["chain-ranking", "chains"], ["chain-groups", "chains"], ["shared-types", "chains"], ["residue", "inventory"]] as const) {
      expect(command(file), file).toContain(`--param-file ${name}=`);
    }
  });
});

// ------------------------------------------------- oracles, from the model itself

function graphOf(lang: Language): CodeGraph {
  return buildGraph(loadModels(readModelFileSync(fixture(lang)), { sources: [lang] }).union);
}

const measure = (entity: Entity, key: string): number | undefined => {
  const value = (entity as { metrics?: Record<string, unknown> }).metrics?.[key];
  return typeof value === "number" ? value : undefined;
};

describe("branching-by-type counts each operation in the nearest type around it", () => {
  /**
   * The same climb, in memory: from the operation's parent upward to the first
   * `TType`, stopping at the top of the chain (its module) when there is none.
   * A lambda therefore counts in the class of the method that holds it — the
   * sum the city draws as a building's height.
   */
  function expected(lang: Language): string[][] {
    const graph = graphOf(lang);
    const owners = new Map<string, { kind: string; sum: number; worst: number; count: number }>();
    for (const entity of graph.entities.values()) {
      const value = measure(entity, "cyclomatic");
      if (value === undefined) continue;
      let at = graph.parentOf(entity.id);
      while (at !== undefined) {
        const here = graph.entity(at);
        const above = graph.parentOf(at);
        if (here === undefined || hasTrait(here, "TType") || above === undefined) break;
        at = above;
      }
      if (at === undefined) continue;
      const owner = owners.get(at) ?? { kind: graph.entity(at)!.kind, sum: 0, worst: 0, count: 0 };
      owner.sum += value;
      owner.worst = Math.max(owner.worst, value);
      owner.count += 1;
      owners.set(at, owner);
    }
    return [...owners.entries()]
      .sort((a, b) => b[1].sum - a[1].sum || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 20)
      .map(([id, owner]) => [id, owner.kind, String(owner.sum), String(owner.worst), String(owner.count)]);
  }

  it.each(LANGUAGES)("%s", (lang) => {
    const result = run(query("branching-by-type"), lang);
    expect(result.columns).toEqual(["owner", "kind", "cyclomatic", "worst", "operations"]);
    expect(result.rows.map((row) => row.map(String))).toEqual(expected(lang));
  });

  it("loses no measured operation: without the cut, the counts add up to all of them", () => {
    for (const lang of LANGUAGES) {
      const whole = queryStore(stores.get(lang)!, query("branching-by-type").statement.replace(/\s+LIMIT 20;$/, ";"));
      const counted = whole.rows.reduce((sum, row) => sum + Number(row[4]), 0);
      const measured = [...graphOf(lang).entities.values()].filter((entity) => measure(entity, "cyclomatic") !== undefined).length;
      expect(counted, lang).toBe(measured);
    }
  });
});

describe("size-by-module counts every line once", () => {
  /**
   * A module's lines: its own count when the extractor measured the module (a
   * file), else the lines of the types written DIRECTLY in it — a nested type
   * is already inside the type around it.
   */
  function expected(lang: Language): Map<string, number> {
    const graph = graphOf(lang);
    const sizes = new Map<string, number>();
    for (const module of graph.entities.values()) {
      if (!hasTrait(module, "TModule") || (module as { isStub?: boolean }).isStub === true) continue;
      const own = measure(module, "sloc");
      let lines = own;
      if (lines === undefined) {
        const direct = [...graph.entities.values()].filter(
          (entity) => graph.parentOf(entity.id) === module.id && hasTrait(entity, "TType") && measure(entity, "sloc") !== undefined,
        );
        if (direct.length > 0) lines = direct.reduce((sum, entity) => sum + measure(entity, "sloc")!, 0);
      }
      if (lines !== undefined) sizes.set(module.id, lines);
    }
    return sizes;
  }

  it.each(LANGUAGES)("%s: each module's lines are the model's, and the shares add up", (lang) => {
    const result = run(query("size-by-module"), lang);
    expect(result.columns).toEqual(["module", "sloc", "types", "pct"]);
    const want = expected(lang);
    expect(result.total).toBe(want.size);

    // The query prints the module's symbol; the model's ids end with it.
    const total = [...want.values()].reduce((sum, lines) => sum + lines, 0);
    expect(result.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(total);
    const symbols = new Map([...want.entries()].map(([id, lines]) => [id.slice(id.indexOf(":") + 1), lines]));
    for (const row of result.rows) expect(symbols.get(String(row[0])), `${lang}: ${String(row[0])}`).toBe(Number(row[1]));
    expect(result.rows.reduce((sum, row) => sum + Number(row[3]), 0)).toBeCloseTo(100, 0);
  });

  it("does not count a nested type's lines twice (java: Basket holds Basket.Line and Basket.Cursor)", () => {
    const largest = run(query("largest-types"), "java").rows;
    const lines = (id: string): number => Number(largest.find((row) => row[0] === id)?.[2]);
    expect(lines("java:com.acme.order/Basket")).toBeGreaterThan(lines("java:com.acme.order/Basket.Line") + lines("java:com.acme.order/Basket.Cursor"));

    // The sum of EVERY type's lines is larger than the package's size by exactly the nested ones.
    const all = queryStore(
      stores.get("java")!,
      `SELECT sum(em.value) AS n FROM entity_metric em JOIN entity e ON e.id = em.entity_id JOIN entity m ON m.id = e.module_id
        WHERE em.key = 'sloc' AND m.symbol = 'com.acme.order' AND e.parent_id IS NOT NULL
          AND e.trait_set_id IN (SELECT s.trait_set_id FROM trait_set_member s JOIN trait t ON t.id = s.trait_id WHERE t.name = 'TType')`,
    ).rows[0]![0];
    const module = run(query("size-by-module"), "java").rows.find((row) => row[0] === "com.acme.order")!;
    expect(Number(all) - Number(module[1])).toBe(14 + 6 + 5);
  });
});

describe("the other step-1 queries agree with the model", () => {
  it.each(LANGUAGES)("%s: summary is the model's own counts", (lang) => {
    const graph = graphOf(lang);
    const entities = [...graph.entities.values()];
    const [row] = run(query("summary"), lang).rows;
    expect(row![1]).toBe(entities.length);
    expect(row![2]).toBe(entities.filter((entity) => (entity as { isStub?: boolean }).isStub === true).length);
  });

  it.each(LANGUAGES)("%s: kinds counts every entity that is not a stub, once", (lang) => {
    const entities = [...graphOf(lang).entities.values()].filter((entity) => (entity as { isStub?: boolean }).isStub !== true);
    const result = run(query("kinds"), lang);
    expect(result.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(entities.length);
    expect(new Set(result.rows.map((row) => row[0]))).toEqual(new Set(entities.map((entity) => entity.kind)));
  });

  it.each(LANGUAGES)("%s: largest-types lists only types, largest first", (lang) => {
    const graph = graphOf(lang);
    const result = run(query("largest-types"), lang);
    const sizes = result.rows.map((row) => Number(row[2]));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const row of result.rows) expect(hasTrait(graph.entity(String(row[0]))!, "TType"), String(row[0])).toBe(true);
  });
});

// ------------------------------------------------------------ step 2: boundaries

const isStub = (entity: Entity | undefined): boolean => (entity as { isStub?: boolean } | undefined)?.isStub === true;

describe("external-modules and module-reach count the references that leave the code", () => {
  /**
   * Every edge whose target is a stub, by the target's module — counted from
   * the model. The module is the one in the entity's KEY, read with core's own
   * decoder: a name nothing declares has no `parent` to climb, and is in the
   * module it was written against all the same.
   */
  function leaving(lang: Language): { module: string; own: boolean; from: string; fromStub: boolean }[] {
    const graph = graphOf(lang);
    const moduleOf = (id: string): { symbol: string; entity: Entity | undefined } => {
      const key = parseRenderedId(id);
      return { symbol: key.module, entity: graph.entity(renderId({ lang: key.lang, module: key.module, symbol: "" })) };
    };
    const out: { module: string; own: boolean; from: string; fromStub: boolean }[] = [];
    for (const edge of graph.edges) {
      if (!isStub(graph.entity(edge.to))) continue;
      const module = moduleOf(edge.to);
      if (module.entity === undefined) throw new Error(`${lang}: the module of ${edge.to} is not an entity`);
      out.push({ module: module.symbol, own: !isStub(module.entity), from: moduleOf(edge.from).symbol, fromStub: isStub(graph.entity(edge.from)) });
    }
    return out;
  }

  it.each(LANGUAGES)("%s: external-modules is every stub-bound reference, by module", (lang) => {
    const result = run(query("external-modules"), lang);
    expect(result.columns).toEqual(["external_module", "own", "refs"]);
    const want = new Map<string, { own: number; refs: number }>();
    for (const edge of leaving(lang)) {
      const row = want.get(edge.module) ?? { own: edge.own ? 1 : 0, refs: 0 };
      row.refs += 1;
      want.set(edge.module, row);
    }
    expect(result.truncated).toBe(false);
    expect(new Map(result.rows.map((row) => [String(row[0]), { own: Number(row[1]), refs: Number(row[2]) }]))).toEqual(
      want,
    );
    const refs = result.rows.map((row) => Number(row[2]));
    expect(refs).toEqual([...refs].sort((a, b) => b - a));
  });

  it("marks as its own the module of a name nothing declares (java: Invoice, written in com.acme.order)", () => {
    const rows = run(query("external-modules"), "java").rows;
    expect(rows.filter((row) => row[1] === 1)).toEqual([
      ["com.acme.order", 1, 3],
      ["com.acme.order.adapter", 1, 2], // AuditTrail, the same way
    ]);
  });

  it.each(LANGUAGES)("%s: module-reach is the same references, from the code only, to external modules only", (lang) => {
    const result = run(query("module-reach"), lang);
    expect(result.columns).toEqual(["module", "reaches", "refs"]);
    const want = new Map<string, number>();
    for (const edge of leaving(lang)) {
      if (edge.own || edge.fromStub) continue;
      const key = JSON.stringify([edge.from, edge.module]);
      want.set(key, (want.get(key) ?? 0) + 1);
    }
    expect(new Map(result.rows.map((row) => [JSON.stringify([row[0], row[1]]), Number(row[2])]))).toEqual(want);
    // No row reaches a module of the code itself.
    const own = new Set(run(query("external-modules"), lang).rows.filter((row) => row[1] === 1).map((row) => row[0]));
    expect(result.rows.filter((row) => own.has(row[1]!))).toEqual([]);
  });
});

describe("annotations and annotated-with read the annotationUse edges", () => {
  const uses = (lang: Language): Edge[] => graphOf(lang).edges.filter((edge) => edge.edge === "annotationUse");
  const nameOf = (lang: Language, id: string): string => (graphOf(lang).entity(id) as { name?: string }).name ?? "";

  it.each(LANGUAGES)("%s: the census counts every use once", (lang) => {
    const result = run(query("annotations"), lang);
    expect(result.columns).toEqual(["annotation", "declared_in", "uses"]);
    expect(result.rows.reduce((sum, row) => sum + Number(row[2]), 0)).toBe(uses(lang).length);
    expect(new Set(result.rows.map((row) => row[0]))).toEqual(new Set(uses(lang).map((edge) => nameOf(lang, edge.to))));
  });

  it.each(LANGUAGES)("%s: annotated-with returns the uses of the names asked for, and no other", (lang) => {
    const names = JSON.parse(NAMES[lang]) as string[];
    const result = run(query("annotated-with"), lang);
    expect(result.columns).toEqual(["annotation", "arguments", "annotated"]);
    const want = uses(lang).filter((edge) => names.includes(nameOf(lang, edge.to)));
    expect(result.rows.map((row) => String(row[2])).sort()).toEqual(want.map((edge) => edge.from).sort());
    for (const row of result.rows) expect(names).toContain(row[0]);
  });

  it("carries the arguments as they were written (java: @Audited(\"monthly\"))", () => {
    const row = run(query("annotated-with"), "java").rows.find((candidate) => candidate[2] === "java:com.acme.order/Reporting.max(java.util.List)")!;
    expect(JSON.parse(String(row[1]))).toEqual([{ name: "value", value: { k: "string", v: "monthly" } }]);
  });

  it("is refused without its list, by name, before anything runs", () => {
    expect(() => queryStore(stores.get("java")!, query("annotated-with").statement)).toThrow(/names/);
  });

  /**
   * The page's own use of the statement: a Spring controller's routes. No
   * fixture has Spring, so the smallest model that does is built here — a
   * controller, two mapped methods, the annotations as stubs in their real
   * packages, which is how an extractor without a classpath emits them.
   */
  it("finds a Spring controller's routes, paths included", () => {
    const id = (module: string, symbol: string): string => renderId({ lang: "java", module, symbol });
    const pkg = (module: string, stub: boolean): Entity =>
      ({ id: id(module, ""), kind: "package", traits: ["TNamed", "TModule", "TWithChildren"], name: module, definedIn: [], isStub: stub }) as unknown as Entity;
    const annotation = (module: string, name: string): Entity =>
      ({ id: id(module, name), kind: "annotation", traits: ["TNamed", "TType", "TChildOf"], name, isStub: true, parent: id(module, "") }) as unknown as Entity;
    const anchor = { file: "com/shop/OrderController.java", span: [1, 9] };
    const use = (from: string, to: string, path?: string): Edge =>
      ({
        edge: "annotationUse",
        from,
        to,
        provenance: "declared",
        anchor,
        ...(path === undefined ? {} : { arguments: [{ name: "value", value: { k: "string", v: path } }] }),
      }) as unknown as Edge;
    const web = "org.springframework.web.bind.annotation";
    const controller = id("com.shop", "OrderController");
    const method = (symbol: string): Entity =>
      ({ id: id("com.shop", symbol), kind: "method", traits: ["TNamed", "TInvocable", "TChildOf", "TSourceAnchor"], name: symbol, signature: "()", isStub: false, parent: controller, anchor }) as unknown as Entity;
    const model = {
      schemaVersion: "1.0.0",
      lang: "java",
      extractor: { name: "test", version: "0" },
      root: "shop/src",
      entities: [
        pkg("com.shop", false),
        pkg(web, true),
        annotation(web, "RestController"),
        annotation(web, "GetMapping"),
        annotation(web, "PostMapping"),
        annotation(web, "Deprecated"),
        { id: controller, kind: "class", traits: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"], name: "OrderController", isStub: false, parent: id("com.shop", ""), anchor } as unknown as Entity,
        method("OrderController.show()"),
        method("OrderController.place()"),
      ],
      edges: [
        use(controller, id(web, "RestController")),
        use(id("com.shop", "OrderController.show()"), id(web, "GetMapping"), "/orders/{id}"),
        use(id("com.shop", "OrderController.place()"), id(web, "PostMapping"), "/orders"),
        use(id("com.shop", "OrderController.place()"), id(web, "Deprecated")),
      ],
    } as unknown as Model;
    const file = join(scratch, "spring.jsonl");
    writeFileSync(file, encodeModelToString(model), "utf8");
    importModel(file, join(scratch, "spring.db"));
    const db = loadSqlite().open(join(scratch, "spring.db"), { ...STORE_OPEN_OPTIONS, readOnly: true });
    try {
      createHelperViews(db);
      const names = '["RestController","Controller","RequestMapping","GetMapping","PostMapping","PutMapping","DeleteMapping","PatchMapping"]';
      const rows = queryStore(db, query("annotated-with").statement, { params: { names } }).rows;
      expect(rows.map((row) => [row[0], row[2]])).toEqual([
        ["RestController", "java:com.shop/OrderController"],
        ["PostMapping", "java:com.shop/OrderController.place()"],
        ["GetMapping", "java:com.shop/OrderController.show()"],
      ]);
      expect(rows.map((row) => (row[1] === null ? null : (JSON.parse(String(row[1])) as { value: { v: string } }[])[0]!.value.v))).toEqual([null, "/orders", "/orders/{id}"]);
      // The same list is the one the page prints, name for name.
      expect(readDoc("discover/boundaries.md")).toContain(`--param names='${names}'`);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------------- step 4: stimuli and flows

/**
 * The same rules, in memory, from the model alone. Each statement of step 4 is
 * compared with what these say on all five fixtures: the statements are long,
 * recursive, and were wrong in ways only a count from the model showed (a
 * residue that was always empty, because every type was tied to its package).
 */
type Loose = Entity & { name?: string; isStub?: boolean; parent?: string; parameters?: string[]; declaredType?: string; attachedTo?: string };
type LooseEdge = Edge & { candidates?: string[] };
const SUPER = new Set(["inheritance", "interfaceImplementation", "traitUsage"]);

interface Shape {
  readonly entities: ReadonlyMap<string, Loose>;
  readonly edges: readonly LooseEdge[];
  readonly children: ReadonlyMap<string, readonly Loose[]>;
  /** A type, with every type above it. */
  readonly above: ReadonlyMap<string, ReadonlySet<string>>;
  readonly uncalled: ReadonlySet<string>;
  /** What a call may also run: an operation of the same name and arity in a type below. */
  readonly dispatch: ReadonlyMap<string, readonly string[]>;
  owner(id: string): string;
}

const shapes = new Map<Language, Shape>();
function shapeOf(lang: Language): Shape {
  const known = shapes.get(lang);
  if (known !== undefined) return known;
  const graph = graphOf(lang);
  const entities = graph.entities as ReadonlyMap<string, Loose>;
  const edges = graph.edges as readonly LooseEdge[];
  const invocable = (id: string | undefined): boolean => id !== undefined && entities.has(id) && hasTrait(entities.get(id)!, "TInvocable");
  const isType = (id: string): boolean => hasTrait(entities.get(id)!, "TType");
  const arity = (entity: Loose): number => (entity.parameters ?? []).length;

  const children = new Map<string, Loose[]>();
  for (const entity of entities.values()) {
    if (entity.parent === undefined) continue;
    children.set(entity.parent, [...(children.get(entity.parent) ?? []), entity]);
  }
  const direct = new Map<string, Set<string>>();
  for (const edge of edges) if (SUPER.has(edge.edge)) direct.set(edge.from, (direct.get(edge.from) ?? new Set()).add(edge.to));
  const above = new Map<string, Set<string>>();
  for (const type of direct.keys()) {
    const seen = new Set<string>();
    const queue = [...direct.get(type)!];
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(direct.get(at) ?? []));
    }
    above.set(type, seen);
  }

  const called = new Set<string>();
  for (const edge of edges) {
    if (edge.edge === "invocation") called.add(edge.to);
    for (const candidate of edge.candidates ?? []) called.add(candidate);
  }
  const dispatch = new Map<string, string[]>();
  const overriding = new Set<string>();
  for (const [type, supers] of above) {
    for (const top of supers) {
      for (const upper of children.get(top) ?? []) {
        for (const lower of children.get(type) ?? []) {
          if (lower.name !== upper.name || upper.name === undefined || arity(lower) !== arity(upper)) continue;
          if (called.has(upper.id)) overriding.add(lower.id);
          if (invocable(upper.id) && invocable(lower.id)) dispatch.set(upper.id, [...(dispatch.get(upper.id) ?? []), lower.id]);
        }
      }
    }
  }
  const uncalled = new Set<string>();
  for (const entity of entities.values()) {
    if (!invocable(entity.id) || entity.isStub === true || entity.name === undefined || entity.kind === "constructor") continue;
    if (invocable(entity.parent) || called.has(entity.id) || overriding.has(entity.id)) continue;
    uncalled.add(entity.id);
  }
  const owner = (id: string): string => {
    let at = id;
    while (!isType(at) && entities.get(at)!.parent !== undefined) at = entities.get(at)!.parent!;
    return at;
  };
  const shape: Shape = { entities, edges, children, above, uncalled, dispatch, owner };
  shapes.set(lang, shape);
  return shape;
}

/** SQLite's GLOB, for the patterns the tables use: `*` and `?`, case kept. */
const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "s");

type InventoryRow = readonly [id: string, layer: string, evidence: string | null, stimulus: string | null];

function expectedInventory(lang: Language): InventoryRow[] {
  const shape = shapeOf(lang);
  const table = JSON.parse(STACKS[lang]) as Record<"annotations" | "supertypes" | "types" | "operations" | "entries", Record<string, string>> & { conventional: string[] };
  const byName = (name: string): Loose[] => [...shape.entities.values()].filter((entity) => entity.name === name);
  const rows: InventoryRow[] = [];
  const taken = new Set<string>();
  const layer = (found: InventoryRow[]): void => {
    rows.push(...found.filter((row) => !taken.has(row[0])));
    for (const row of found) taken.add(row[0]);
  };

  layer(shape.edges.filter((edge) => edge.edge === "annotationUse" && shape.entities.get(edge.to)!.name! in table.annotations).map((edge) => {
    const name = shape.entities.get(edge.to)!.name!;
    return [edge.from, "annotation", name, table.annotations[name]!] as const;
  }));
  layer(Object.entries(table.supertypes).flatMap(([name, stimulus]) =>
    byName(name).flatMap((top) =>
      [...shape.above].filter(([, supers]) => supers.has(top.id)).flatMap(([type]) =>
        (shape.children.get(type) ?? []).filter((child) => shape.uncalled.has(child.id)).map((child) => [child.id, "supertype", name, stimulus] as const)))));
  layer(Object.entries(table.entries).map(([id, stimulus]) => [id, "by hand", null, stimulus] as const));
  layer(Object.entries(table.types).flatMap(([pattern, stimulus]) =>
    [...shape.entities.values()].filter((entity) => entity.name !== undefined && glob(pattern).test(entity.name)).flatMap((type) =>
      (shape.children.get(type.id) ?? []).filter((child) => shape.uncalled.has(child.id)).map((child) => [child.id, "type name", pattern, stimulus] as const))));
  layer([...shape.uncalled].map((id) => [id, "no caller", null, table.operations[shape.entities.get(id)!.name!] ?? null] as const)
    .filter(([id, , , stimulus]) => stimulus !== null || !table.conventional.includes(shape.entities.get(id)!.name!)));
  return rows;
}

const byText = (a: readonly unknown[], b: readonly unknown[]): number => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

/** Everything `from` reaches, with the fewest hops, by the rules of `reach.sql`. */
function expectedReach(lang: Language, from: string, candidates: boolean): Map<string, number> {
  const shape = shapeOf(lang);
  const steps = (id: string): string[] => [
    ...shape.edges.filter((edge) => edge.from === id && (edge.edge === "invocation" || edge.edge === "access") && (candidates || edge.provenance === "declared")).map((edge) => edge.to),
    ...(hasTrait(shape.entities.get(id)!, "TInvocable") ? (shape.children.get(id) ?? []).filter((child) => hasTrait(child, "TInvocable")).map((child) => child.id) : []),
    ...(candidates ? shape.edges.filter((edge) => edge.from === id).flatMap((edge) => edge.candidates ?? []) : []),
    ...(candidates ? (shape.dispatch.get(id) ?? []) : []),
  ];
  const depth = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (depth.get(at)! >= 20) continue;
    for (const next of steps(at)) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(at)! + 1);
      queue.push(next);
    }
  }
  return depth;
}

describe("supertypes counts the code's types under each external one", () => {
  it.each(LANGUAGES)("%s", (lang) => {
    const shape = shapeOf(lang);
    const want = new Map<string, Set<string>>();
    for (const edge of shape.edges) {
      if (!SUPER.has(edge.edge) || !isStub(shape.entities.get(edge.to)) || isStub(shape.entities.get(edge.from))) continue;
      const key = JSON.stringify([edge.to, edge.edge]);
      want.set(key, (want.get(key) ?? new Set()).add(edge.from));
    }
    const result = run(query("supertypes"), lang);
    expect(result.columns).toEqual(["supertype", "relation", "types", "example"]);
    expect(new Map(result.rows.map((row) => [JSON.stringify([row[0], row[1]]), Number(row[2])]))).toEqual(new Map([...want].map(([key, set]) => [key, set.size])));
  });
});

describe("entry-points finds each row by the strongest layer that has it", () => {
  it.each(LANGUAGES)("%s: the rows are the model's, layer for layer", (lang) => {
    const result = run(query("entry-points"), lang);
    expect(result.columns).toEqual(["entry_point", "kind", "layer", "evidence", "stimulus", "calls", "arguments"]);
    const got = result.rows.map((row) => [row[0], row[2], row[3], row[4]]);
    expect([...got].sort(byText)).toEqual([...expectedInventory(lang)].sort(byText));
  });

  it("uses every layer on the page's table, and shows an id nobody declares instead of dropping it", () => {
    const layers = (rows: readonly (readonly unknown[])[]): string[] => [...new Set(rows.map((row) => String(row[2])))];
    expect(layers(run(query("entry-points"), "java").rows)).toEqual(["annotation", "supertype", "by hand", "type name", "no caller"]);
    const typo = JSON.stringify({ entries: { "java:nowhere/Nothing.at()": "temporal" } });
    const rows = queryStore(stores.get("java")!, query("entry-points").statement, { params: { stack: typo } }).rows;
    expect(rows.find((row) => row[2] === "by hand")).toEqual(["java:nowhere/Nothing.at()", null, "by hand", null, "temporal", 0, null]);
  });

  it("leaves out what has a caller the model does not draw", () => {
    const java = shapeOf("java");
    // An interface's operation that is called takes its implementations with it…
    const csharp = shapeOf("csharp");
    expect(csharp.uncalled.has("csharp:Acme.Order/Money.Price()")).toBe(false);
    expect(csharp.uncalled.has("csharp:Acme.Order/OrderService.Bill(Acme.Order.Order)")).toBe(true);
    // …a lambda runs with its method, and a constructor is built by whoever wires it.
    const nested = [...java.entities.values()].filter((entity) => entity.kind === "lambda" || entity.kind === "constructor").map((entity) => entity.id);
    expect(nested.length).toBeGreaterThan(5);
    const listed = new Set(run(query("entry-points"), "java").rows.map((row) => row[0]));
    expect(nested.filter((id) => listed.has(id))).toEqual([]);
  });

  it("drops a name the language itself calls, unless the table names it", () => {
    const withMain = (operations: Record<string, string>): readonly (readonly unknown[])[] =>
      queryStore(stores.get("ruby")!, query("entry-points").statement, {
        params: { stack: JSON.stringify({ operations, conventional: ["initialize"] }) },
      }).rows.filter((row) => String(row[0]).endsWith(".initialize"));
    expect(withMain({})).toEqual([]);
    expect(withMain({ initialize: "lifecycle" }).length).toBeGreaterThan(0);
  });
});

describe("entry-point-kinds is the inventory, counted by kind", () => {
  it.each(LANGUAGES)("%s: every entry point is counted once, under its kind, its layer and the name that found it", (lang) => {
    const want = new Map<string, Set<string>>();
    for (const row of run(query("entry-points"), lang).rows) {
      const key = JSON.stringify([row[4] ?? "unclassified", row[2], row[3]]);
      want.set(key, (want.get(key) ?? new Set()).add(String(row[0])));
    }
    const result = run(query("entry-point-kinds"), lang);
    expect(result.columns).toEqual(["stimulus", "layer", "evidence", "entry_points", "example"]);
    expect(new Map(result.rows.map((row) => [JSON.stringify(row.slice(0, 3)), Number(row[3])]))).toEqual(new Map([...want].map(([key, set]) => [key, set.size])));
    // What no table names comes last, whatever the kinds are called.
    const kinds = result.rows.map((row) => String(row[0]));
    expect(kinds.indexOf("unclassified")).toBe(kinds.lastIndexOf("unclassified") - kinds.filter((kind) => kind === "unclassified").length + 1);
    expect(kinds.slice(kinds.indexOf("unclassified")).every((kind) => kind === "unclassified")).toBe(true);
  });
});

describe("reach and chains walk the same steps", () => {
  it.each(LANGUAGES.flatMap((lang) => [[lang, 0] as const, [lang, 1] as const]))("%s, candidates=%i: reach is the model's breadth-first walk", (lang, candidates) => {
    const result = queryStore(stores.get(lang)!, query("reach").statement, { params: { id: REACH_FROM[lang], candidates } });
    expect(result.columns).toEqual(["id", "external", "depth"]);
    expect(new Map(result.rows.map((row) => [String(row[0]), Number(row[2])]))).toEqual(expectedReach(lang, REACH_FROM[lang], candidates === 1));
  });

  it("the candidates add what dispatch and a candidate list reach, and only there", () => {
    const count = (lang: Language, candidates: number): number =>
      queryStore(stores.get(lang)!, query("reach").statement, { params: { id: REACH_FROM[lang], candidates } }).total;
    expect([count("csharp", 0), count("csharp", 1)]).toEqual([3, 9]); // the page's own numbers
    expect(count("elixir", 1)).toBeGreaterThan(count("elixir", 0)); // a protocol call and its implementations
    expect(count("ruby", 1)).toBeGreaterThan(count("ruby", 0));
    expect(count("java", 1)).toBe(count("java", 0)); // nothing there calls through an interface
    expect(STIMULI_PAGE).toMatch(/reaches 3 entities on facts\s+and 9 with the candidates/);
  });

  it("the two statements hold one definition of a step", () => {
    const steps = (name: string): string => {
      const text = query(name).statement;
      return text.slice(text.indexOf("above(type, super)"), text.indexOf("reach(") === -1 ? undefined : text.search(/\n(classified|reach)\(/));
    };
    expect(steps("reach").length).toBeGreaterThan(900);
    expect(steps("chains")).toBe(steps("reach"));
  });

  it.each(LANGUAGES)("%s: chains is every classified operation's walk, folded to the types around what it reaches", (lang) => {
    const shape = shapeOf(lang);
    const seeds = [...new Set(run(query("entry-points"), lang).rows.filter((row) => row[4] !== null && shape.entities.has(String(row[0]))).map((row) => String(row[0])))]
      .filter((id) => hasTrait(shape.entities.get(id)!, "TInvocable"));
    expect(seeds.length).toBeGreaterThan(0);
    const want: [string, string, number, number][] = [];
    for (const seed of seeds) {
      const folded = new Map<string, number>();
      for (const [id, depth] of expectedReach(lang, seed, lang !== "java")) {
        const type = shape.owner(id);
        folded.set(type, Math.min(folded.get(type) ?? depth, depth));
      }
      for (const [type, depth] of folded) want.push([seed, type, isStub(shape.entities.get(type)) ? 1 : 0, depth]);
    }
    const result = run(query("chains"), lang);
    expect(result.columns).toEqual(["entry_point", "type", "external", "depth", "file"]);
    expect(result.rows.map((row) => row.slice(0, 4)).sort(byText)).toEqual(want.sort(byText));
  });
});

describe("what the chains give: a ranking, groups, the shared kernel", () => {
  const members = (lang: Language): { entry: string; type: string; external: number; depth: number; file: string | null }[] =>
    run(query("chains"), lang).rows.map((row) => ({ entry: String(row[0]), type: String(row[1]), external: Number(row[2]), depth: Number(row[3]), file: row[4] as string | null }));

  it.each(LANGUAGES)("%s: chain-ranking counts each chain's types, exits and hotspot files", (lang) => {
    const hot = new Set(lang === "java" ? (JSON.parse(PAGE_HOTSPOTS) as { rows: { model: string }[] }).rows.map((row) => row.model) : []);
    const want = new Map<string, number[]>();
    for (const entry of new Set(members(lang).map((member) => member.entry))) {
      const mine = members(lang).filter((member) => member.entry === entry);
      want.set(entry, [
        mine.filter((member) => member.external === 0).length,
        mine.filter((member) => member.external === 1).length,
        Math.max(...mine.map((member) => member.depth)),
        new Set(mine.map((member) => member.file).filter((file) => file !== null && hot.has(file))).size,
      ]);
    }
    const result = run(query("chain-ranking"), lang);
    expect(result.columns).toEqual(["entry_point", "types", "exits", "depth", "hotspots"]);
    expect(new Map(result.rows.map((row) => [String(row[0]), row.slice(1).map(Number)]))).toEqual(want);
  });

  it("counts only the first ten rows of the hotspot report", () => {
    const eleven = JSON.stringify({ rows: [...Array.from({ length: 10 }, (_unused, index) => ({ model: `nowhere/${index}.java` })), { model: "com/acme/order/Money.java" }] });
    const rows = queryStore(stores.get("java")!, query("chain-ranking").statement, { params: { chains: saved("chains", "java"), hotspots: eleven } }).rows;
    expect(rows.every((row) => row[4] === 0)).toBe(true);
  });

  it.each(LANGUAGES)("%s: chain-groups ties two chains that share half their types, plumbing left out", (lang) => {
    const own = members(lang).filter((member) => member.external === 0);
    const entries = [...new Set(own.map((member) => member.entry))].sort();
    const chainsOf = new Map<string, number>();
    for (const member of own) chainsOf.set(member.type, (chainsOf.get(member.type) ?? 0) + 1);
    const typesOf = new Map(entries.map((entry) => [entry, new Set(own.filter((member) => member.entry === entry && 2 * chainsOf.get(member.type)! <= entries.length).map((member) => member.type))]));
    const label = new Map(entries.map((entry) => [entry, entry]));
    const find = (entry: string): string => (label.get(entry) === entry ? entry : find(label.get(entry)!));
    for (const a of entries) {
      for (const b of entries) {
        if (a >= b) continue;
        const shared = [...typesOf.get(a)!].filter((type) => typesOf.get(b)!.has(type)).length;
        if (shared === 0 || (100 * shared) / (typesOf.get(a)!.size + typesOf.get(b)!.size - shared) < 50) continue;
        const [low, high] = [find(a), find(b)].sort() as [string, string];
        label.set(high, low);
      }
    }
    const result = run(query("chain-groups"), lang);
    expect(result.columns).toEqual(["group_of", "entry_points", "entry_point", "types"]);
    expect(new Map(result.rows.map((row) => [String(row[2]), String(row[0])]))).toEqual(new Map(entries.map((entry) => [entry, find(entry)])));
    expect(result.rows.map((row) => Number(row[3]))).toEqual(result.rows.map((row) => own.filter((member) => member.entry === row[2]).length));
  });

  it.each(LANGUAGES)("%s: shared-types counts the chains through each type of the code", (lang) => {
    const own = members(lang).filter((member) => member.external === 0);
    const want = new Map<string, number>();
    for (const member of own) want.set(member.type, (want.get(member.type) ?? 0) + 1);
    const result = queryStore(stores.get(lang)!, query("shared-types").statement.replace(/\s+LIMIT 20;$/, ";"), { params: paramsFor("shared-types", lang) });
    expect(result.columns).toEqual(["type", "chains", "pct"]);
    expect(new Map(result.rows.map((row) => [String(row[0]), Number(row[1])]))).toEqual(want);
  });
});

describe("residue is what nothing reachable from an entry point mentions", () => {
  function expectedResidue(lang: Language): string[] {
    const shape = shapeOf(lang);
    const isType = (id: string): boolean => hasTrait(shape.entities.get(id)!, "TType");
    const uses = new Map<string, Set<string>>();
    const use = (a: string | undefined, b: string | undefined): void => {
      if (a === undefined || b === undefined) return;
      uses.set(shape.owner(a), (uses.get(shape.owner(a)) ?? new Set()).add(shape.owner(b)));
    };
    for (const edge of shape.edges) {
      use(edge.from, edge.to);
      for (const candidate of edge.candidates ?? []) use(edge.from, candidate);
    }
    for (const entity of shape.entities.values()) {
      use(entity.id, entity.declaredType);
      use(entity.id, entity.attachedTo);
      use(entity.attachedTo, entity.attachedTo === undefined ? undefined : entity.id);
      if (entity.parent !== undefined && isType(entity.id) && isType(entity.parent)) {
        uses.set(entity.parent, (uses.get(entity.parent) ?? new Set()).add(entity.id));
        uses.set(entity.id, (uses.get(entity.id) ?? new Set()).add(entity.parent));
      }
    }
    const touched = new Set<string>();
    const queue = run(query("entry-points"), lang).rows.filter((row) => row[4] !== null && shape.entities.has(String(row[0]))).map((row) => shape.owner(String(row[0])));
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (touched.has(at)) continue;
      touched.add(at);
      queue.push(...(uses.get(at) ?? []));
    }
    return [...shape.entities.values()]
      .filter((entity) => entity.isStub !== true && !touched.has(entity.id))
      .filter((entity) => isType(entity.id) || (entity.parent === undefined && (shape.children.get(entity.id) ?? []).some((child) => child.isStub !== true && hasTrait(child, "TInvocable") && !hasTrait(child, "TType"))))
      .map((entity) => entity.id);
  }

  it.each(LANGUAGES)("%s: the rows are the model's untouched types", (lang) => {
    const result = run(query("residue"), lang);
    expect(result.columns).toEqual(["type", "kind", "file", "sloc", "revisions"]);
    const want = expectedResidue(lang);
    expect(want.length, "a fixture stack that leaves nothing out tests nothing").toBeGreaterThan(0);
    expect(result.rows.map((row) => String(row[0])).sort()).toEqual(want.sort());
  });

  it("is not tied together by a package: a type is touched by a mention, never by its address", () => {
    const rows = run(query("residue"), "java").rows.map((row) => String(row[0]));
    expect(rows).toContain("java:com.acme.order/StockGuard");
    expect(rows).not.toContain("java:com.acme.order/Money"); // reached by Order.discount(int)
    expect(rows.filter((id) => !id.includes("/"))).toEqual([]); // no package
  });

  it("splits by the file's revisions when a history is given, and says NULL when none is", () => {
    const withHistory = run(query("residue"), "java").rows;
    expect(withHistory.filter((row) => Number(row[4]) > 0).map((row) => row[2])).toEqual(Array.from({ length: 4 }, () => "com/acme/order/Basket.java"));
    expect(withHistory.filter((row) => row[4] === 0).length).toBeGreaterThan(0);
    const without = queryStore(stores.get("java")!, query("residue").statement, { params: { inventory: saved("entry-points", "java"), activity: NO_ROWS } }).rows;
    expect(without.length).toBe(withHistory.length);
    expect(without.every((row) => row[4] === null)).toBe(true);
  });

  it("reads the inventory's columns where entry-points puts them", () => {
    const columns = run(query("entry-points"), "java").columns;
    expect([columns[0], columns[4]]).toEqual(["entry_point", "stimulus"]);
    for (const name of ["chains", "residue"]) {
      expect(query(name).statement).toContain("json_extract(r.value, '$[0]')");
      expect(query(name).statement).toContain("json_extract(r.value, '$[4]') IS NOT NULL");
    }
  });
});
