import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServeOptions } from "../src/args.js";
import { CITY_ROUTE, NAVIGATOR_ROUTE, serveCommand } from "../src/commands/serve.js";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { runSync } from "../src/main.js";

/**
 * `codegraph serve` over the committed Spoon output: ONE page, TWO artifacts.
 * What is checked is the command's contract — both routes handed to the
 * server, the city laid out, stdout empty, the flags passing through, the
 * frontend resolved before any model is read — not the transforms, which
 * `@codegraph/navigator` and `@codegraph/city` own.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

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
    ...overrides,
  };
}

interface StartedServer {
  routes: Readonly<Record<string, string>>;
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
    assetsDir: () => "/fake/navigator-ui/dist",
    startServer: (serverOptions) => {
      started.push({
        routes: serverOptions.routes,
        assets: serverOptions.assets,
        port: serverOptions.port,
        host: serverOptions.host,
        label: serverOptions.label,
      });
      return undefined;
    },
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
      }),
    ).toThrow(UsageError);
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
