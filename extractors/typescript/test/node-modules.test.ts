import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extract } from "../src/extraction.js";
import { VERSION } from "../src/main.js";
import { renderKey } from "../src/model/keys.js";
import { Progress } from "../src/progress.js";

/**
 * External keys never depend on what is installed (PLAN.md §14, principle 3):
 * a type from an installed package is a stub in the module named by the
 * package, and `--ignore-node-modules` makes the install invisible — the
 * import edge survives either way, keyed by the specifier as written.
 */
const scratch = mkdtempSync(join(tmpdir(), "codegraph-ts-nm-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const corpus = join(scratch, "corpus");
mkdirSync(join(corpus, "src"), { recursive: true });
mkdirSync(join(corpus, "node_modules", "zod", "v4"), { recursive: true });
writeFileSync(join(corpus, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [] } }));
writeFileSync(join(corpus, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "4.0.0", types: "index.d.ts" }));
writeFileSync(join(corpus, "node_modules", "zod", "index.d.ts"), "export declare class ZodType { parse(x: unknown): unknown; }\nexport declare function object(shape: unknown): ZodType;\n");
writeFileSync(join(corpus, "node_modules", "zod", "v4", "index.d.ts"), "export * from \"../index.js\";\n");
writeFileSync(
  join(corpus, "src", "schema.ts"),
  'import { object, ZodType } from "zod";\nimport { object as object4 } from "zod/v4";\n' +
    "export class Schema extends ZodType {\n  build(): ZodType {\n    object4({});\n    return object({});\n  }\n}\n",
);

function ids(ignoreNodeModules: boolean): { entities: string[]; edges: string[] } {
  const { model } = extract(
    { sources: ["corpus"], cwd: scratch, repository: undefined, tsconfig: undefined, allowJs: false, ignoreNodeModules },
    Progress.silent(),
    VERSION,
  );
  return {
    entities: model.entities.map((e) => renderKey(e.key)).sort(),
    edges: model.edges.map((e) => `${e.kind} ${renderKey(e.from)} -> ${renderKey(e.to)}`).sort(),
  };
}

describe("installed packages", () => {
  it("keys an installed type by its package name and folds calls to it, the subpath import by its specifier", () => {
    const { entities, edges } = ids(false);
    expect(entities).toContain("ts:zod/ZodType");
    expect(entities).toContain("ts:zod");
    expect(entities).toContain("ts:zod%2Fv4");
    expect(entities.some((id) => id.includes("node_modules"))).toBe(false);
    expect(edges).toContain("inheritance ts:src%2Fschema.ts/Schema -> ts:zod/ZodType");
    expect(edges).toContain("import ts:src%2Fschema.ts -> ts:zod");
    expect(edges).toContain("import ts:src%2Fschema.ts -> ts:zod%2Fv4");
    // A free function of the package folds to the package's module stub.
    expect(edges).toContain("invocation ts:src%2Fschema.ts/Schema.build -> ts:zod");
  });

  it("with --ignore-node-modules sees no install: the import edges survive, the type is unresolved, the calls are dropped", () => {
    const { entities, edges } = ids(true);
    expect(entities).not.toContain("ts:zod/ZodType");
    expect(entities).toContain("ts:<unresolved>/ZodType");
    expect(edges).toContain("import ts:src%2Fschema.ts -> ts:zod");
    expect(edges).toContain("import ts:src%2Fschema.ts -> ts:zod%2Fv4");
    expect(edges).toContain("inheritance ts:src%2Fschema.ts/Schema -> ts:<unresolved>/ZodType");
    expect(edges.some((edge) => edge.startsWith("invocation"))).toBe(false);
  });
});
