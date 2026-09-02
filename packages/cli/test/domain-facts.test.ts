import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DomainFactsOptions } from "../src/args.js";
import { domainFactsCommand } from "../src/commands/domain-facts.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph domain-facts` over the committed Spoon output. What is checked
 * here is the COMMAND's contract — stream purity, exit codes, flags reaching
 * the transform — not the dossier's own rules, which are the analyzer's suite.
 */
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

function options(overrides: Partial<DomainFactsOptions> = {}): DomainFactsOptions {
  return {
    models: [FIXTURE],
    framework: undefined,
    internalOnly: false,
    declaredOnly: false,
    noCache: true,
    out: undefined,
    ...overrides,
  };
}

function factsTo(overrides: Partial<DomainFactsOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = domainFactsCommand(options(overrides), io);
  return { io, code };
}

interface FactsJson {
  kind: string;
  generatedBy: string;
  view: { name: string };
  langs: string[];
  framework?: string;
  modules: { id: string; types: string[] }[];
  types: { id: string; kind: string; operations: unknown[]; fields: unknown[] }[];
  diagnostics: { types: number; operations: number };
}

function parse(stdout: string): FactsJson {
  return JSON.parse(stdout) as FactsJson;
}

describe("domain-facts: the artifact", () => {
  it("writes the dossier artifact and nothing else on stdout", () => {
    const { io, code } = factsTo();
    expect(code).toBe(EXIT.OK);
    const facts = parse(io.stdout());
    expect(facts.kind).toBe("codegraph.domainFacts/1");
    expect(facts.generatedBy).toBe("@codegraph/analyzer");
    expect(facts.langs).toEqual(["java"]);
    expect(io.stderr()).not.toContain("codegraph.domainFacts/1");
  });

  it("emits one dossier per corpus type, sorted", () => {
    const facts = parse(factsTo().io.stdout());
    expect(facts.types.length).toBeGreaterThan(0);
    expect(facts.diagnostics.types).toBe(facts.types.length);
    const ids = facts.types.map((type) => type.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("is byte-identical across runs", () => {
    expect(factsTo().io.stdout()).toBe(factsTo().io.stdout());
  });

  it("carries the view into the artifact", () => {
    expect(parse(factsTo().io.stdout()).view.name).toBe("all");
    expect(parse(factsTo({ internalOnly: true }).io.stdout()).view.name).toBe("internalOnly");
  });

  it("names the framework profile it applied, and applies none by default", () => {
    expect(parse(factsTo().io.stdout()).framework).toBeUndefined();
    expect(parse(factsTo({ framework: "spring" }).io.stdout()).framework).toBe("spring");
  });
});

describe("domain-facts: --out", () => {
  it("writes the artifact to the file and confirms on stderr, leaving stdout empty", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-df-")), "domain-facts.json");
    const { io, code } = factsTo({ out: path });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(path);
    expect(parse(io.files().get(path) as string).kind).toBe("codegraph.domainFacts/1");
  });
});

describe("domain-facts: through the real dispatcher", () => {
  it("runs from argv", () => {
    const io = captureIo();
    const code = run(["domain-facts", FIXTURE, "--no-cache", "--framework", "spring"], io);
    expect(code).toBe(EXIT.OK);
    expect(parse(io.stdout()).framework).toBe("spring");
  });

  it("appears in the global help", () => {
    const io = captureIo();
    expect(run(["--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("domain-facts");
  });

  it("rejects a framework nobody profiled, naming the valid ones", () => {
    const io = captureIo();
    const code = run(["domain-facts", FIXTURE, "--framework", "rails"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("spring");
  });
});
