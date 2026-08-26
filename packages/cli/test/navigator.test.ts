import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NavigatorOptions } from "../src/args.js";
import { navigatorCommand } from "../src/commands/navigator.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph navigator` over the committed Spoon output. What is checked here
 * is the COMMAND's contract — stream purity, exit codes, flags reaching the
 * transform, the serve seam — not the transform's own rules, which are
 * `@codegraph/navigator`'s suite.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

function options(overrides: Partial<NavigatorOptions> = {}): NavigatorOptions {
  return {
    models: [FIXTURE],
    name: undefined,
    internalOnly: false,
    declaredOnly: false,
    noCache: true,
    serve: false,
    port: 4178,
    out: undefined,
    ...overrides,
  };
}

function navigatorTo(overrides: Partial<NavigatorOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = navigatorCommand(options(overrides), io);
  return { io, code };
}

interface NavigatorJson {
  kind: string;
  generatedBy: string;
  view: { name: string };
  corpus: { name: string; roots: string[] };
  files: string[];
  nodes: { name: string; kind: string; category: string; children: number[]; parent?: number }[];
  roots: number[];
  deps: { role: string; from: number; to: number; provenance: string }[];
  diagnostics: { selfDeps: number; droppedDeps: number };
}

function parse(stdout: string): NavigatorJson {
  return JSON.parse(stdout) as NavigatorJson;
}

describe("navigator: the artifact", () => {
  it("writes a navigator model and nothing else on stdout", () => {
    const { io, code } = navigatorTo();
    expect(code).toBe(EXIT.OK);
    const model = parse(io.stdout());
    expect(model.kind).toBe("codegraph.navigator/1");
    expect(model.generatedBy).toBe("@codegraph/navigator");
    expect(io.stderr()).not.toContain("codegraph.navigator/1");
  });

  it("is a browsable tree with dependency rows", () => {
    const model = parse(navigatorTo().io.stdout());
    expect(model.roots.length).toBeGreaterThan(0);
    expect(model.nodes.length).toBeGreaterThan(model.roots.length);
    expect(model.deps.length).toBeGreaterThan(0);
    expect(new Set(model.nodes.map((node) => node.category))).toEqual(
      new Set(["module", "type", "operation", "attribute"]),
    );
  });

  it("carries the view into the artifact", () => {
    expect(parse(navigatorTo().io.stdout()).view.name).toBe("all");
    expect(parse(navigatorTo({ internalOnly: true }).io.stdout()).view.name).toBe("internalOnly");
  });

  it("drops externals under --internal-only", () => {
    const full = parse(navigatorTo().io.stdout());
    const internal = parse(navigatorTo({ internalOnly: true }).io.stdout());
    expect(internal.nodes.length).toBeLessThan(full.nodes.length);
    expect(full.nodes.some((node) => node.name === "java.lang")).toBe(true);
    expect(internal.nodes.some((node) => node.name === "java.lang")).toBe(false);
  });

  it("is byte-identical across runs", () => {
    expect(navigatorTo().io.stdout()).toBe(navigatorTo().io.stdout());
  });

  it("defaults the corpus name to the model root's basename, and takes --name", () => {
    expect(parse(navigatorTo().io.stdout()).corpus.name).toBe("src");
    expect(parse(navigatorTo({ name: "acme" }).io.stdout()).corpus.name).toBe("acme");
  });
});

describe("navigator: --out", () => {
  it("writes the artifact to the file and confirms on stderr, leaving stdout empty", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-nav-")), "navigator.json");
    const { io, code } = navigatorTo({ out: path });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(path);
    expect(io.stderr()).toContain("dependency row");
    expect(parse(io.files().get(path) as string).kind).toBe("codegraph.navigator/1");
  });
});

describe("navigator: the cache seam", () => {
  it("says on stderr what answered the query", () => {
    // --no-cache is the deterministic path for a test that must not write a
    // sibling .db next to a committed fixture.
    expect(navigatorTo().io.stderr()).toContain("cache: not used");
  });
});

describe("navigator --serve", () => {
  interface StartedServer {
    artifact: string;
    artifactRoute: string;
    assets: string;
    port: number;
    label: string;
  }

  /** The seam: no sockets, no built frontend — just what the command handed over. */
  function serveTo(overrides: Partial<NavigatorOptions> = {}) {
    const io = captureIo();
    const started: StartedServer[] = [];
    const code = navigatorCommand(options({ serve: true, ...overrides }), io, {
      assetsDir: () => "/fake/navigator-ui/dist",
      startServer: (serverOptions) => {
        started.push({
          artifact: serverOptions.artifact,
          artifactRoute: serverOptions.artifactRoute,
          assets: serverOptions.assets,
          port: serverOptions.port,
          label: serverOptions.label,
        });
        return undefined;
      },
    });
    return { io, code, started };
  }

  it("hands the server the artifact at /navigator.json", () => {
    const { code, started } = serveTo();
    expect(code).toBe(EXIT.OK);
    expect(started).toHaveLength(1);
    expect(started[0]?.artifactRoute).toBe("/navigator.json");
    expect(parse(started[0]?.artifact ?? "").kind).toBe("codegraph.navigator/1");
  });

  it("keeps stdout empty: the server is the artifact's destination", () => {
    expect(serveTo().io.stdout()).toBe("");
  });

  it("still writes --out alongside serving", () => {
    const path = join(mkdtempSync(join(tmpdir(), "codegraph-cli-nav-serve-")), "navigator.json");
    const { io, started } = serveTo({ out: path });
    expect(io.files().get(path)).toBe(started[0]?.artifact);
  });

  it("passes the requested port through", () => {
    expect(serveTo({ port: 0 }).started[0]?.port).toBe(0);
  });

  it("fails BEFORE loading models when the frontend is not built", () => {
    const io = captureIo();
    expect(() =>
      navigatorCommand(options({ serve: true, models: ["/nonexistent.jsonl"] }), io, {
        assetsDir: () => {
          throw new UsageError("the frontend is not built", "Run pnpm -r build.");
        },
        startServer: () => undefined,
      }),
    ).toThrow(UsageError);
  });
});

describe("navigator: through the real dispatcher", () => {
  it("runs from argv", () => {
    const io = captureIo();
    const code = run(["navigator", FIXTURE, "--no-cache", "--internal-only"], io);
    expect(code).toBe(EXIT.OK);
    expect(parse(io.stdout()).kind).toBe("codegraph.navigator/1");
  });

  it("appears in the global help", () => {
    const io = captureIo();
    expect(run(["--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("navigator");
  });

  it("defaults --port to 4178, distinct from the city's 4177", () => {
    const io = captureIo();
    expect(run(["navigator", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("default: 4178");
  });

  it("rejects an out-of-range port before doing any work", () => {
    const io = captureIo();
    const code = run(["navigator", FIXTURE, "--port", "99999"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("--port");
  });
});
