import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  census,
  detect,
  launchOf,
  parseRegistry,
  treeFingerprint,
  type ExtractorEntry,
} from "../src/app/registry.js";
import { UsageError } from "../src/exit.js";

/**
 * The registry is DATA the shell hands over (PLAN §15, invariant 8 applied to
 * extractors): the daemon runs an entry under the §13.5 command-line contract
 * and never names a language. Detection is a census of file extensions; a tie
 * is a question, never a guess.
 */
type Installed = ExtractorEntry & { readonly path: string };
const JAVA: Installed = { name: "java", path: "/opt/codegraph-java", extensions: [".java"], launch: "exec", env: {}, install: undefined };
const CSHARP: Installed = { name: "csharp", path: "/opt/codegraph-csharp", extensions: [".cs"], launch: "exec", env: {}, install: undefined };
const TS: Installed = {
  name: "typescript",
  path: "/opt/homebrew/bin/codegraph-typescript",
  extensions: [".ts", ".tsx"],
  launch: "exec",
  env: { NODE_OPTIONS: "--max-old-space-size=8192" },
  install: undefined,
};
/** Known to the shell's catalogue, not found on this machine. */
const ELIXIR_MISSING: ExtractorEntry = {
  name: "elixir",
  path: null,
  extensions: [".ex", ".exs"],
  launch: "exec",
  env: {},
  install: "brew install defsquare/tap/codegraph-elixir",
};
const JAVA_MISSING: ExtractorEntry = { ...JAVA, path: null, install: "brew install defsquare/tap/codegraph-java" };

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "codegraph-census-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

describe("parseRegistry", () => {
  it("accepts a list of entries and infers the launch from the path", () => {
    const registry = parseRegistry(
      JSON.stringify([
        { name: "java", path: "/x/codegraph-java.jar", extensions: [".java"] },
        { name: "typescript", path: "/x/cli.js", extensions: [".ts"] },
        { name: "csharp", path: "/x/codegraph-csharp", extensions: [".cs"], env: { A: "1" } },
      ]),
      "registry.json",
    );
    expect(registry.map((entry) => entry.launch)).toEqual(["java", "node", "exec"]);
    expect(registry[2]?.env).toEqual({ A: "1" });
  });

  it("normalizes extensions to lower case with a leading dot", () => {
    const [entry] = parseRegistry(JSON.stringify([{ name: "x", path: "/x", extensions: ["TS", ".Tsx"] }]), "r");
    expect(entry?.extensions).toEqual([".ts", ".tsx"]);
  });

  it("accepts an entry without a path when it carries its install line — known, not installed", () => {
    const [entry] = parseRegistry(
      JSON.stringify([{ name: "elixir", extensions: [".ex"], install: "brew install defsquare/tap/codegraph-elixir" }]),
      "r",
    );
    expect(entry).toEqual({
      name: "elixir",
      path: null,
      extensions: [".ex"],
      launch: "exec",
      env: {},
      install: "brew install defsquare/tap/codegraph-elixir",
    });
  });

  it.each([
    ["not json", "{"],
    ["not a list", `{"name":"java"}`],
    ["a missing name", `[{"path":"/x","extensions":[".java"]}]`],
    ["neither a path nor an install line", `[{"name":"java","extensions":[".java"]}]`],
    ["no extensions", `[{"name":"java","path":"/x","extensions":[]}]`],
    ["a duplicate name", `[{"name":"java","path":"/x","extensions":[".java"]},{"name":"java","path":"/y","extensions":[".kt"]}]`],
    ["an unknown launch", `[{"name":"java","path":"/x","extensions":[".java"],"launch":"docker"}]`],
    ["a non-string env value", `[{"name":"java","path":"/x","extensions":[".java"],"env":{"A":1}}]`],
  ])("refuses %s as a usage error naming the file", (_label, text) => {
    expect(() => parseRegistry(text, "registry.json")).toThrow(UsageError);
    expect(() => parseRegistry(text, "registry.json")).toThrow(/registry\.json/);
  });
});

describe("launchOf", () => {
  it("runs a binary as it is, a jar under java, a script under this node", () => {
    expect(launchOf({ ...JAVA, launch: "exec" }, ["--src", "s"])).toEqual({
      command: "/opt/codegraph-java",
      args: ["--src", "s"],
      env: {},
    });
    expect(launchOf({ ...JAVA, path: "/x/a.jar", launch: "java" }, []).command).toBe("java");
    expect(launchOf({ ...JAVA, path: "/x/a.jar", launch: "java" }, []).args).toEqual(["-jar", "/x/a.jar"]);
    expect(launchOf({ ...JAVA, path: "/x/cli.js", launch: "node" }, ["--out", "o"]).command).toBe(process.execPath);
    expect(launchOf({ ...JAVA, path: "/x/cli.js", launch: "node" }, ["--out", "o"]).args).toEqual(["/x/cli.js", "--out", "o"]);
  });

  it("carries the entry's environment verbatim", () => {
    expect(launchOf(TS, []).env).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
  });
});

describe("census + detect", () => {
  it("counts files per claimed extension and skips dot-directories and node_modules", () => {
    const root = tree({
      "src/A.java": "class A {}",
      "src/B.java": "class B {}",
      "web/x.ts": "export {}",
      "node_modules/dep/index.ts": "export {}",
      ".git/HEAD": "ref",
      "README.md": "# hi",
    });
    const counted = census(root, [JAVA, CSHARP, TS]);
    expect(counted.byExtension).toEqual(new Map([[".java", 2], [".md", 1], [".ts", 1]]));
    expect(counted.files.map((file) => file.relative).sort()).toEqual(["src/A.java", "src/B.java", "web/x.ts"]);
  });

  it("picks the one extractor whose extensions are present", () => {
    const root = tree({ "src/A.java": "", "README.md": "" });
    const decision = detect(census(root, [JAVA, CSHARP, TS]), [JAVA, CSHARP, TS]);
    expect(decision).toEqual({ kind: "one", entry: JAVA, files: 1 });
  });

  it("asks when several extractors claim files — most files first, never a guess", () => {
    const root = tree({ "a.java": "", "b.cs": "", "c.cs": "" });
    const decision = detect(census(root, [JAVA, CSHARP]), [JAVA, CSHARP]);
    expect(decision).toEqual({
      kind: "ambiguous",
      candidates: [
        { name: "csharp", files: 2 },
        { name: "java", files: 1 },
      ],
    });
  });

  it("says when nothing is claimed, naming what the tree holds", () => {
    const root = tree({ "a.py": "", "b.py": "", "c.rb": "" });
    const decision = detect(census(root, [JAVA]), [JAVA]);
    expect(decision).toEqual({ kind: "none", seen: [".py", ".rb"] });
  });

  it("takes a named extractor as an answer to the question", () => {
    const root = tree({ "a.java": "", "b.cs": "" });
    expect(detect(census(root, [JAVA, CSHARP]), [JAVA, CSHARP], "java")).toEqual({ kind: "one", entry: JAVA, files: 1 });
    expect(detect(census(root, [JAVA, CSHARP]), [JAVA, CSHARP], "go")).toEqual({ kind: "unknown", name: "go" });
  });

  it("answers not-installed, with the install line, when only missing extractors claim the tree", () => {
    const root = tree({ "lib/a.ex": "", "lib/b.ex": "", "README.md": "" });
    const registry = [JAVA, ELIXIR_MISSING];
    expect(detect(census(root, registry), registry)).toEqual({
      kind: "not-installed",
      extractors: [{ name: "elixir", files: 2, install: "brew install defsquare/tap/codegraph-elixir" }],
    });
  });

  it("still asks when an installed and a missing extractor both claim files, offering the missing one's install line", () => {
    const root = tree({ "a.java": "", "b.ex": "", "c.ex": "" });
    const registry = [JAVA, ELIXIR_MISSING];
    expect(detect(census(root, registry), registry)).toEqual({
      kind: "ambiguous",
      candidates: [
        { name: "elixir", files: 2, install: "brew install defsquare/tap/codegraph-elixir" },
        { name: "java", files: 1 },
      ],
    });
  });

  it("answers not-installed when the chosen extractor is a missing one", () => {
    const root = tree({ "a.java": "" });
    const registry = [JAVA_MISSING];
    expect(detect(census(root, registry), registry, "java")).toEqual({
      kind: "not-installed",
      extractors: [{ name: "java", files: 1, install: "brew install defsquare/tap/codegraph-java" }],
    });
  });

  it("counts a missing extractor's files in the census, so its tree is never 'nothing claims this'", () => {
    const root = tree({ "a.ex": "" });
    expect(census(root, [ELIXIR_MISSING]).files.map((file) => file.relative)).toEqual(["a.ex"]);
  });
});

describe("treeFingerprint", () => {
  it("is stable across runs and independent of walk order", () => {
    const root = tree({ "a/A.java": "a", "b/B.java": "b" });
    const one = treeFingerprint(census(root, [JAVA]), JAVA);
    const two = treeFingerprint(census(root, [JAVA]), JAVA);
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a claimed file changes, and ignores files the extractor would not read", () => {
    const root = tree({ "a/A.java": "a", "notes.md": "n" });
    const before = treeFingerprint(census(root, [JAVA]), JAVA);
    writeFileSync(join(root, "notes.md"), "changed");
    expect(treeFingerprint(census(root, [JAVA]), JAVA)).toBe(before);
    writeFileSync(join(root, "a/A.java"), "a2");
    utimesSync(join(root, "a/A.java"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    expect(treeFingerprint(census(root, [JAVA]), JAVA)).not.toBe(before);
  });
});
