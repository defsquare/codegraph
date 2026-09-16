import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { directoryAssets, seaFrontendAssets, serveStatic, type FrontendAssets } from "./assets.js";
import { UsageError } from "./exit.js";
import { errLine, type IoSink } from "./io.js";
import { isSeaImage } from "./sea.js";

export { serveStatic, type FrontendAssets } from "./assets.js";

/**
 * `codegraph serve` / `history --serve` / `replay --serve`: a frontend with
 * THESE artifacts loaded.
 *
 * The CLI stays inside its architectural box — it moves bytes. Each frontend
 * is a PREBUILT static bundle (Three.js and React never enter the CLI's import
 * graph; the dependency is assets-only, resolved at runtime), and each
 * artifact is handed to the page at its own JSON route, exactly the file
 * `--out` would have written. Nothing is computed here.
 *
 * WHICH INTERFACE IT BINDS is the caller's decision (`--host`). A code model
 * can be sensitive, so whenever the bind address is not loopback the
 * announcement SAYS the page is reachable from other machines — an exposure
 * nobody should discover by accident.
 */

/** The default when a caller does not choose: this machine only. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Bind addresses that mean "every interface on this machine". */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "[::]"]);

function isLoopback(host: string): boolean {
  return host === LOOPBACK_HOST || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * How to reach the page, and whether anyone else can. A wildcard bind has no
 * single URL, so the line names the loopback one that certainly works and
 * states the reach separately rather than printing `http://0.0.0.0:4178/`,
 * which is not an address a browser should be given.
 */
function reachLine(host: string, port: number): string {
  if (WILDCARD_HOSTS.has(host)) {
    return `http://localhost:${port}/ (every interface — reachable from other machines)`;
  }
  if (isLoopback(host)) return `http://localhost:${port}/`;
  return `http://${host}:${port}/ (reachable from other machines)`;
}

/**
 * A frontend's built bundle: in the single-executable image its assets under
 * `<prefix>/` (PLAN §15.3); in a checkout the package's `dist/`, where a
 * usage-shaped error names the fix when it is not built.
 */
function frontendAssetsFor(packageName: string, distPath: string, seaPrefix: string): FrontendAssets {
  if (isSeaImage()) {
    const assets = seaFrontendAssets(seaPrefix);
    if (assets.read("index.html") === undefined) {
      throw new UsageError(
        `this codegraph image carries no ${seaPrefix} frontend`,
        "The single-executable was built without its assets; rebuild it with ./build.sh --sea.",
      );
    }
    return assets;
  }
  let packagePath: string;
  try {
    packagePath = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new UsageError(
      `the frontend package (${packageName}) cannot be resolved`,
      "Run 'pnpm install' at the workspace root, then 'pnpm -r build'.",
      { cause: error },
    );
  }
  const assets = join(dirname(packagePath), "dist");
  if (!existsSync(join(assets, "index.html"))) {
    throw new UsageError(
      `the frontend is not built (no ${distPath}/index.html)`,
      `Run 'pnpm --filter ${packageName} build' (or 'pnpm -r build') and retry.`,
    );
  }
  return directoryAssets(assets);
}

export function vizAssets(): FrontendAssets {
  return frontendAssetsFor("@codegraph/viz", "packages/viz/dist", "viz");
}

export function navigatorAssets(): FrontendAssets {
  return frontendAssetsFor("@codegraph/navigator-ui", "packages/navigator-ui/dist", "navigator-ui");
}

export interface ArtifactServerOptions {
  /**
   * Absolute route → serialized artifact, each served verbatim: the page
   * fetches `/navigator.json` and `/city.json`; a replay page only `/city.json`.
   */
  readonly routes: Readonly<Record<string, string>>;
  /** What the stderr announcement calls the page, e.g. `city visualizer`. */
  readonly label: string;
  /** The frontend's static bundle (vizAssets() / navigatorAssets()). */
  readonly assets: FrontendAssets;
  /** 0 = ephemeral; the actual port is announced on stderr once listening. */
  readonly port: number;
  /** Bind address; defaults to loopback. `0.0.0.0` = every interface. */
  readonly host?: string;
  readonly io: IoSink;
}

/** The replay pages' server options: one city artifact, the historical shape. */
export type CityServerOptions = Omit<ArtifactServerOptions, "routes" | "label"> & {
  /** The serialized city — served verbatim at `/city.json`. */
  readonly artifact: string;
};

export function startCityServer(options: CityServerOptions): Server {
  const { artifact, ...rest } = options;
  return startArtifactServer({ ...rest, routes: { "/city.json": artifact }, label: "city visualizer" });
}

/**
 * Start the server and return it (the caller — or Ctrl-C — closes it). The
 * command returns its exit code immediately; the live server is what keeps the
 * process alive, so `--serve` behaves like any dev server. Bind failures (port
 * taken) surface on stderr, not as a crash.
 */
/**
 * A bind that failed, in the terms of the flag that caused it. A wrong
 * `--host` fails as EADDRNOTAVAIL — "address not available" alone sends the
 * reader looking at the port, so it names the address and the flag instead.
 */
export function bindFailure(
  error: NodeJS.ErrnoException,
  host: string,
  options: { readonly port: number; readonly label: string },
): string {
  if (error.code === "EADDRINUSE") {
    return `codegraph: port ${options.port} is already in use — pick another with --port (0 = any free port).`;
  }
  if (error.code === "EADDRNOTAVAIL" || error.code === "EINVAL") {
    return (
      `codegraph: cannot bind ${host} — no interface on this machine has that address. ` +
      `Use --host 0.0.0.0 for every interface, or 127.0.0.1 for this machine only.`
    );
  }
  if (error.code === "EACCES") {
    return `codegraph: not allowed to bind ${host}:${options.port} — ports below 1024 usually need root.`;
  }
  return `codegraph: the ${options.label} server failed: ${error.message}`;
}

/**
 * A JSON body, verbatim, with its exact byte size — the page's loading
 * pipeline shows a DETERMINATE progress bar while it streams an artifact in.
 * Never cached: under the app daemon the same route serves a different
 * project after the next job.
 */
export function sendJson(response: ServerResponse, status: number, body: string, method = "GET"): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : body);
}

export function startArtifactServer(options: ArtifactServerOptions): Server {
  const { routes, assets, io } = options;

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");

    // Own keys only: `/constructor` must not fetch Object.prototype's.
    const artifact = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    if (artifact !== undefined) {
      sendJson(response, 200, artifact, method);
      return;
    }
    serveStatic(assets, pathname, method, response);
  });

  const host = options.host ?? LOOPBACK_HOST;

  server.on("error", (error: NodeJS.ErrnoException) => {
    errLine(io, bindFailure(error, host, options));
    server.close();
  });

  server.listen(options.port, host, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    errLine(io, `${options.label} at ${reachLine(host, port)} — Ctrl-C to stop.`);
  });

  return server;
}
