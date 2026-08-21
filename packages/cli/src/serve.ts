import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { UsageError } from "./exit.js";
import { errLine, type IoSink } from "./io.js";

/**
 * `codegraph city --serve`: the visualizer on localhost, with THIS city loaded.
 *
 * The CLI stays inside its architectural box — it moves bytes. The visualizer
 * is `@codegraph/viz`'s PREBUILT static bundle (Three.js never enters the
 * CLI's import graph; the dependency is assets-only, resolved at runtime), and
 * the artifact is handed to the page as `/city.json`, exactly the file
 * `--layout --out city.json` would have written. Nothing is computed here.
 *
 * Localhost only: the server binds 127.0.0.1 — a code model can be sensitive,
 * and serving it on all interfaces is a decision the user has not made.
 */

/** Where the built visualizer lives; a usage-shaped error names the fix. */
export function vizAssetsDir(): string {
  let packagePath: string;
  try {
    packagePath = createRequire(import.meta.url).resolve("@codegraph/viz/package.json");
  } catch (error) {
    throw new UsageError(
      "the visualizer package (@codegraph/viz) cannot be resolved",
      "Run 'pnpm install' at the workspace root, then 'pnpm -r build'.",
      { cause: error },
    );
  }
  const assets = join(dirname(packagePath), "dist");
  if (!existsSync(join(assets, "index.html"))) {
    throw new UsageError(
      "the visualizer is not built (no packages/viz/dist/index.html)",
      "Run 'pnpm --filter @codegraph/viz build' (or 'pnpm -r build') and retry.",
    );
  }
  return assets;
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface CityServerOptions {
  /** The serialized laid-out city — served verbatim as /city.json. */
  readonly artifact: string;
  /** The visualizer's static bundle (vizAssetsDir()). */
  readonly assets: string;
  /** 0 = ephemeral; the actual port is announced on stderr once listening. */
  readonly port: number;
  readonly io: IoSink;
}

/**
 * Start the server and return it (the caller — or Ctrl-C — closes it). The
 * command returns its exit code immediately; the live server is what keeps the
 * process alive, so `codegraph city m.jsonl --serve` behaves like any dev
 * server. Bind failures (port taken) surface on stderr, not as a crash.
 */
export function startCityServer(options: CityServerOptions): Server {
  const { artifact, assets, io } = options;
  const root = resolve(assets);

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");

    if (pathname === "/city.json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(method === "HEAD" ? undefined : artifact);
      return;
    }

    // Static file, jailed to the assets directory: normalize, then verify the
    // resolved path is still under root — traversal answers 404, not a file.
    const relative = normalize(pathname).replace(/^[/\\]+/, "");
    const file = resolve(root, relative === "" || relative === "." ? "index.html" : relative);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    response.end(method === "HEAD" ? undefined : body);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    errLine(
      io,
      error.code === "EADDRINUSE"
        ? `codegraph: port ${options.port} is already in use — pick another with --port (0 = any free port).`
        : `codegraph: the visualizer server failed: ${error.message}`,
    );
    server.close();
  });

  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    errLine(io, `city visualizer at http://localhost:${port}/ — Ctrl-C to stop.`);
  });

  return server;
}
