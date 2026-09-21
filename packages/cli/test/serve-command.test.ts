import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSqlite } from "@codegraph/analyzer";
import { INSIGHTS_GENERATOR, INSIGHTS_KIND, INSIGHTS_METAMODEL, PROMPT_VERSION, sqliteInsightsStore, type InsightRecord } from "@codegraph/insights";
import { parseInvocation, type ServeOptions } from "../src/args.js";
import type { DaemonOptions } from "../src/app/daemon.js";
import { defaultDataDir } from "../src/app/store.js";
import { CITY_ROUTE, NAVIGATOR_ROUTE, registrySource, serveCommand } from "../src/commands/serve.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { runSync } from "../src/main.js";
import type { FrontendAssets } from "../src/assets.js";
import type { ArtifactServerOptions } from "../src/serve.js";

/**
 * `codegraph serve` over the committed Spoon output: ONE page, TWO artifacts.
 * What is checked is the command's contract — both routes handed to the
 * server, the city laid out, stdout empty, the flags passing through, the
 * frontend resolved before any model is read — not the transforms, which
 * `@codegraph/navigator` and `@codegraph/city` own.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

/** A bundle that is never read: the command only hands it over. */
const FAKE_ASSETS: FrontendAssets = { label: "/fake/navigator-ui/dist", read: () => undefined };

function options(overrides: Partial<ServeOptions> = {}): ServeOptions {
  return {
    models: [FIXTURE],
    height: "loc",
    heightScale: "linear",
    footprint: "members",
    footprintScale: "sqrt",
    carry: [],
    name: undefined,
    framework: undefined,
    internalOnly: false,
    declaredOnly: false,
    noCache: true,
    port: 4177,
    host: "0.0.0.0",
    app: undefined,
    insights: undefined,
    ...overrides,
  };
}

interface StartedServer {
  routes: Readonly<Record<string, string>>;
  lookups: ArtifactServerOptions["lookups"];
  onClose: ArtifactServerOptions["onClose"];
  assets: string;
  port: number;
  host: string | undefined;
  label: string;
}

/** The seam: no sockets, no built frontend — just what the command handed over. */
function serveTo(overrides: Partial<ServeOptions> = {}) {
  const io = captureIo();
  const started: StartedServer[] = [];
  const code = serveCommand(options(overrides), io, {
    assetsDir: () => FAKE_ASSETS,
    startServer: (serverOptions) => {
      started.push({
        routes: serverOptions.routes,
        lookups: serverOptions.lookups,
        onClose: serverOptions.onClose,
        assets: serverOptions.assets.label,
        port: serverOptions.port,
        host: serverOptions.host,
        label: serverOptions.label,
      });
      return undefined;
    },
    startDaemon: () => {
      throw new Error("the classic form must not start the daemon");
    },
    stdin: undefined,
  });
  return { io, code, started };
}

function parse<T>(text: string | undefined): T {
  return JSON.parse(text ?? "") as T;
}

describe("serve: both artifacts, one server", () => {
  it("hands the server the navigator AND the city, each at its own route", () => {
    const { code, started } = serveTo();
    expect(code).toBe(EXIT.OK);
    expect(started).toHaveLength(1);
    const routes = started[0]?.routes ?? {};
    expect(Object.keys(routes).sort()).toEqual([CITY_ROUTE, NAVIGATOR_ROUTE].sort());
    expect(parse<{ kind: string }>(routes[NAVIGATOR_ROUTE]).kind).toBe("codegraph.navigator/1");
    expect(parse<{ kind: string }>(routes[CITY_ROUTE]).kind).toBe("codegraph.city/1");
  });

  it("lays the city out: the viewer refuses a city with no placement", () => {
    const { started } = serveTo();
    const city = parse<{ layout: { algorithm: string }; buildings: { position?: unknown }[] }>(
      started[0]?.routes[CITY_ROUTE],
    );
    expect(city.layout.algorithm).toBe("shelf-rows");
    expect(city.buildings.every((building) => building.position !== undefined)).toBe(true);
  });

  it("builds both under the SAME view, so the city's buildings are the navigator's type nodes", () => {
    const { started } = serveTo({ internalOnly: true });
    const routes = started[0]?.routes ?? {};
    const navigator = parse<{ nodes: { id?: string; category: string }[] }>(routes[NAVIGATOR_ROUTE]);
    const city = parse<{ buildings: { id: string }[] }>(routes[CITY_ROUTE]);
    const typeIds = new Set(
      navigator.nodes.filter((node) => node.category === "type").map((node) => node.id),
    );
    expect(city.buildings.length).toBeGreaterThan(0);
    for (const building of city.buildings) expect(typeIds.has(building.id)).toBe(true);
  });

  it("keeps stdout empty: the server is the destination", () => {
    expect(serveTo().io.stdout()).toBe("");
  });

  it("passes the bind address and port through", () => {
    const { started } = serveTo({ port: 0, host: "127.0.0.1" });
    expect(started[0]?.port).toBe(0);
    expect(started[0]?.host).toBe("127.0.0.1");
    expect(started[0]?.assets).toBe("/fake/navigator-ui/dist");
  });

  it("reaches the city's metric flags", () => {
    const { started } = serveTo({ height: "methods" });
    const city = parse<{ bindings: { channel: string; metric: string }[] }>(started[0]?.routes[CITY_ROUTE]);
    expect(city.bindings.find((binding) => binding.channel === "height")?.metric).toBe("methods");
  });

  it("fails BEFORE loading models when the frontend is not built", () => {
    const io = captureIo();
    expect(() =>
      serveCommand(options({ models: ["/nonexistent.jsonl"] }), io, {
        assetsDir: () => {
          throw new UsageError("the frontend is not built", "Run pnpm -r build.");
        },
        startServer: () => undefined,
        startDaemon: () => undefined,
        stdin: undefined,
      }),
    ).toThrow(UsageError);
  });
});

/**
 * `serve --app`: the daemon form (PLAN §15.2). The command validates the
 * registry, builds one job runner over --data-dir and hands the daemon seam
 * everything it needs; the daemon itself is covered by app-daemon.test.ts.
 */
describe("serve --app: the daemon form", () => {
  const REGISTRY = join(mkdtempSync(join(tmpdir(), "codegraph-serve-app-")), "registry.json");
  writeFileSync(REGISTRY, JSON.stringify([{ name: "java", path: "/opt/codegraph-java", extensions: [".java"] }]));

  function appTo(app: ServeOptions["app"], overrides: Partial<ServeOptions> = {}) {
    const io = captureIo();
    const daemons: DaemonOptions[] = [];
    const code = serveCommand(options({ models: [], port: 0, host: "127.0.0.1", app, ...overrides }), io, {
      assetsDir: () => FAKE_ASSETS,
      startServer: () => {
        throw new Error("the app form must not start the classic server");
      },
      startDaemon: (daemonOptions) => {
        daemons.push(daemonOptions);
        return undefined;
      },
      stdin: undefined,
    });
    return { io, code, daemons };
  }

  it("starts the daemon with the registry, the data directory and the bind address", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codegraph-serve-data-"));
    const { code, daemons, io } = appTo({ dataDir, extractors: REGISTRY });
    expect(code).toBe(EXIT.OK);
    expect(daemons).toHaveLength(1);
    expect(daemons[0]?.registry().map((entry) => entry.name)).toEqual(["java"]);
    expect(daemons[0]?.dataDir).toBe(dataDir);
    expect(daemons[0]?.host).toBe("127.0.0.1");
    expect(daemons[0]?.port).toBe(0);
    expect(daemons[0]?.assets.label).toBe("/fake/navigator-ui/dist");
    expect(daemons[0]?.runner.current).toBeUndefined();
    expect(io.stdout()).toBe("");
  });

  it("runs with an empty registry when none is named — only model.jsonl files open then", () => {
    const { daemons } = appTo({ dataDir: "/tmp/x", extractors: undefined });
    expect(daemons[0]?.registry()).toEqual([]);
  });

  it("follows the registry file: a rewrite is seen by the next call, a broken rewrite keeps the last good one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "codegraph-serve-reg-")), "registry.json");
    writeFileSync(file, JSON.stringify([{ name: "java", path: "/opt/codegraph-java", extensions: [".java"] }]));
    const io = captureIo();
    const source = registrySource({ dataDir: "/tmp/x", extractors: file }, io);
    expect(source().map((entry) => entry.name)).toEqual(["java"]);
    // A different mtime: the file system's clock may be coarse, so set it explicitly.
    writeFileSync(file, JSON.stringify([{ name: "elixir", extensions: [".ex"], install: "brew install x" }]));
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(source().map((entry) => entry.name)).toEqual(["elixir"]);
    expect(io.stderr()).toContain("registry: reloaded");
    writeFileSync(file, "{ not json");
    utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
    expect(source().map((entry) => entry.name)).toEqual(["elixir"]);
    expect(io.stderr()).toContain("keeping the previous entries");
  });

  it("refuses an unreadable or malformed registry as a usage error, before any port is taken", () => {
    expect(() => appTo({ dataDir: "/tmp/x", extractors: "/nonexistent/registry.json" })).toThrow(UsageError);
    const bad = join(mkdtempSync(join(tmpdir(), "codegraph-serve-app-")), "bad.json");
    writeFileSync(bad, "[{}]");
    expect(() => appTo({ dataDir: "/tmp/x", extractors: bad })).toThrow(/bad\.json/);
  });

  it("parses --app: no model, loopback and an ephemeral port by default, the flags carried", () => {
    const parsed = parseInvocation(["serve", "--app", "--data-dir", "/tmp/data", "--extractors", REGISTRY]);
    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run" || parsed.command !== "serve") throw new Error("not serve");
    expect(parsed.options.models).toEqual([]);
    expect(parsed.options.port).toBe(0);
    expect(parsed.options.host).toBe("127.0.0.1");
    expect(parsed.options.app).toEqual({ dataDir: "/tmp/data", extractors: REGISTRY });
  });

  it("defaults --data-dir to the platform's application-data directory", () => {
    const parsed = parseInvocation(["serve", "--app"]);
    if (parsed.kind !== "run" || parsed.command !== "serve") throw new Error("not serve");
    expect(parsed.options.app?.dataDir).toBe(resolve(defaultDataDir()));
    expect(defaultDataDir("darwin", {}, "/Users/me")).toBe("/Users/me/Library/Application Support/codegraph");
    expect(defaultDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/me")).toBe("/data/codegraph");
    expect(defaultDataDir("linux", {}, "/home/me")).toBe("/home/me/.local/share/codegraph");
    expect(defaultDataDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me")).toContain("codegraph");
  });

  it("keeps an explicit --port and --host under --app", () => {
    const parsed = parseInvocation(["serve", "--app", "--port", "4500", "--host", "0.0.0.0"]);
    if (parsed.kind !== "run" || parsed.command !== "serve") throw new Error("not serve");
    expect(parsed.options.port).toBe(4500);
    expect(parsed.options.host).toBe("0.0.0.0");
  });

  it("rejects a model with --app, and the app flags without it", () => {
    const io = captureIo();
    expect(runSync(["serve", "--app", FIXTURE], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--app takes no model");
    const io2 = captureIo();
    expect(runSync(["serve", FIXTURE, "--data-dir", "/tmp/x"], io2)).toBe(EXIT.USAGE);
    expect(io2.stderr()).toContain("--data-dir only means something with --app");
    const io3 = captureIo();
    expect(runSync(["serve", FIXTURE, "--extractors", REGISTRY], io3)).toBe(EXIT.USAGE);
    expect(io3.stderr()).toContain("--extractors only means something with --app");
  });

  it("documents the three flags in the help", () => {
    const io = captureIo();
    expect(runSync(["serve", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("--app");
    expect(io.stdout()).toContain("--data-dir DIR");
    expect(io.stdout()).toContain("--extractors FILE");
  });
});

describe("serve: through the real dispatcher", () => {
  it("appears in the global help", () => {
    const io = captureIo();
    expect(runSync(["--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("serve");
  });

  it("defaults --port to 4177 and --host to every interface, and says so", () => {
    const io = captureIo();
    expect(runSync(["serve", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("default: 4177");
    expect(io.stdout()).toContain("--host ADDR");
    expect(io.stdout()).toContain("default: 0.0.0.0");
    expect(io.stdout()).toContain("reachable from other machines");
  });

  it("rejects an out-of-range port before doing any work", () => {
    const io = captureIo();
    expect(runSync(["serve", FIXTURE, "--port", "99999"], io)).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("--port");
  });

  it("rejects a blank --host rather than silently binding everything", () => {
    const io = captureIo();
    expect(runSync(["serve", FIXTURE, "--host", "   "], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--host needs an address");
  });

  it("turns a bad metric into a usage error naming the flag's help", () => {
    const io = captureIo();
    expect(runSync(["serve", FIXTURE, "--no-cache", "--height", "complexity"], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("unknown metric source: complexity");
  });
});

describe("city and navigator no longer serve: one command does", () => {
  it.each(["city", "navigator"])("%s rejects --serve as an unknown option", (command) => {
    const io = captureIo();
    expect(runSync([command, FIXTURE, "--serve"], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--serve");
  });
});

describe("serve hands the page ONE lookup: a selected node's explanation (M16c)", () => {
  it("registers /insight.json beside the two artifacts, and a model nobody explained answers 404 — no file created", () => {
    const { started } = serveTo();
    const lookup = started[0]?.lookups?.["/insight.json"];
    expect(lookup).toBeTypeOf("function");
    // The fixture has no store beside it: quiet, and asking must not make one.
    expect(lookup?.(new URLSearchParams({ id: "java:com.acme.order/Order" })).status).toBe(404);
    expect(existsSync(FIXTURE.replace(/\.jsonl$/u, ".insights.db"))).toBe(false);
    expect(Object.keys(started[0]?.routes ?? {}).sort()).toEqual(["/city.json", "/navigator.json"]);
    started[0]?.onClose?.();
  });

  it("--insights FILE names the store; the default is <model>.insights.db beside the FIRST model", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-insights-"));
    try {
      const db = join(dir, "elsewhere.insights.db");
      const store = sqliteInsightsStore(loadSqlite().open(db));
      const record: InsightRecord = {
        t: "i", id: "java:com.acme.order/Order", level: "module", kind: "package", origin: "llm", fingerprint: "a".repeat(64),
        block: { name: "o", description: "Ordering.", apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.5 },
      };
      const run = store.beginRun({
        header: { t: "header", kind: INSIGHTS_KIND, generatedBy: INSIGHTS_GENERATOR, promptVersion: PROMPT_VERSION, metamodel: INSIGHTS_METAMODEL, models: { leaf: "m", rollup: "m" }, depth: 1, source: { paths: [], langs: [], view: { name: "all", filters: [] } } },
        startedAt: "t",
      });
      store.putUnit(run, record.id, [record]);
      store.close();

      const { started } = serveTo({ insights: db });
      const answer = started[0]?.lookups?.["/insight.json"]?.(new URLSearchParams({ id: record.id }));
      expect(answer?.status).toBe(200);
      expect(JSON.parse(answer?.body ?? "{}")).toMatchObject({ status: "explained", record: { block: { description: "Ordering." } } });
      started[0]?.onClose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
