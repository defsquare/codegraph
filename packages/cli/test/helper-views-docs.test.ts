import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEP_VIEW_SQL, NODE_VIEW_SQL } from "@codegraph/analyzer";

/**
 * THE DOCUMENTATION SHOWS THE VIEWS THE BINARY CREATES (PLAN.md §24.4).
 *
 * `node` and `dep` have one definition, in `@codegraph/analyzer`
 * (`store/helper-views.ts`): `codegraph query` creates them from it and
 * `codegraph query --views` prints it. Three pages show the same SQL for a
 * reader who pastes it into `sqlite3`, DuckDB or Datasette. Before this test
 * they were three hand-kept copies, and one line of them was wrong for every
 * reader at once (an anonymous TypeScript function rendered `ts:m/#23:2`
 * where every report prints `ts:m#23:2`).
 *
 * Two pages show the views as the code writes them, comment for comment; the
 * tutorial shows a compact form in one block. Both are held: the first two
 * byte for byte, the third up to comments and spacing.
 */

const page = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

/** Every fenced ```sql block of a markdown page, in order. */
function sqlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /```sql\n([\s\S]*?)```/g;
  for (let match = fence.exec(markdown); match !== null; match = fence.exec(markdown)) {
    blocks.push(match[1]!.trim());
  }
  return blocks;
}

/** A statement with its comments dropped and its spacing collapsed. */
const normalized = (sql: string): string =>
  sql
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const VERBATIM = ["website/content/docs/how-to/query-model-db.md", "docs/sql-cookbook.md"] as const;
const COMPACT = "website/content/docs/tutorials/sql.md";

describe("the helper views in the documentation are the ones in the binary", () => {
  it.each(VERBATIM)("%s shows node, then dep, exactly as the code has them", (path) => {
    const blocks = sqlBlocks(page(path));
    const node = blocks.find((block) => block.startsWith("CREATE TEMP VIEW node"));
    const dep = blocks.find((block) => block.startsWith("CREATE TEMP VIEW dep"));
    expect(node, `${path} no longer shows the node view`).toBe(NODE_VIEW_SQL);
    expect(dep, `${path} no longer shows the dep view`).toBe(DEP_VIEW_SQL);
  });

  it(`${COMPACT} shows both in one block, the same statements up to comments and spacing`, () => {
    const block = sqlBlocks(page(COMPACT)).find((candidate) => candidate.startsWith("CREATE TEMP VIEW node"));
    expect(block, `${COMPACT} no longer shows the views`).toBeDefined();
    expect(normalized(block ?? "")).toBe(`${normalized(NODE_VIEW_SQL)} ${normalized(DEP_VIEW_SQL)}`);
  });

  it("no other page defines them: a fourth copy would be the one nobody pins", () => {
    // Every page that creates a view named node or dep must be listed above.
    const known = new Set<string>([...VERBATIM, COMPACT]);
    const defining = listMarkdown().filter((path) => /CREATE\s+(TEMP\s+)?VIEW\s+(node|dep)\b/i.test(page(path)));
    expect(defining.filter((path) => !known.has(path))).toEqual([]);
    expect(defining.length).toBe(known.size);
  });
});

/** Every markdown file under docs/, website/content/ and plugin/, repository-relative. */
function listMarkdown(): string[] {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const walk = (relative: string): string[] => {
    let names: string[];
    try {
      names = readdirSync(`${root}${relative}`);
    } catch {
      return []; // a directory this checkout does not have
    }
    return names.flatMap((name) => {
      const child = `${relative}/${name}`;
      if (statSync(`${root}${child}`).isDirectory()) return walk(child);
      return name.endsWith(".md") ? [child] : [];
    });
  };
  return ["docs", "website/content", "plugin"].flatMap(walk);
}
