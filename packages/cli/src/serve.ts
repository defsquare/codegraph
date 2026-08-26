import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { UsageError } from "./exit.js";
import { errLine, type IoSink } from "./io.js";

/**
 * `codegraph city --serve` / `codegraph navigator --serve`: a frontend on
 * localhost, with THIS artifact loaded.
 *
 * The CLI stays inside its architectural box — it moves bytes. Each frontend
 * is a PREBUILT static bundle (Three.js and React never enter the CLI's import
 * graph; the dependency is assets-only, resolved at runtime), and the artifact
 * is handed to the page at its one JSON route, exactly the file `--out` would
 * have written. Nothing is computed here.
 *
 * Localhost only: the server binds 127.0.0.1 — a code model can be sensitive,
 * and serving it on all interfaces is a decision the user has not made.
 */

/** Where a frontend package's built bundle lives; a usage-shaped error names the fix. */
function assetsDirFor(packageName: string, distPath: string): string {
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
  return assets;
}

export function vizAssetsDir(): string {
  return assetsDirFor("@codegraph/viz", "packages/viz/dist");
}

export function navigatorAssetsDir(): string {
  return assetsDirFor("@codegraph/navigator-ui", "packages/navigator-ui/dist");
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

export interface ArtifactServerOptions {
  /** The serialized artifact — served verbatim at `artifactRoute`. */
  readonly artifact: string;
  /** The absolute route the frontend fetches, e.g. `/city.json`. */
  readonly artifactRoute: string;
  /** What the stderr announcement calls the page, e.g. `city visualizer`. */
  readonly label: string;
  /** The frontend's static bundle (vizAssetsDir() / navigatorAssetsDir()). */
  readonly assets: string;
  /** 0 = ephemeral; the actual port is announced on stderr once listening. */
  readonly port: number;
  readonly io: IoSink;
}

/** The city's server options, kept as the narrower historical shape. */
export type CityServerOptions = Omit<ArtifactServerOptions, "artifactRoute" | "label">;

export function startCityServer(options: CityServerOptions): Server {
  return startArtifactServer({ ...options, artifactRoute: "/city.json", label: "city visualizer" });
}

/**
 * Start the server and return it (the caller — or Ctrl-C — closes it). The
 * command returns its exit code immediately; the live server is what keeps the
 * process alive, so `--serve` behaves like any dev server. Bind failures (port
 * taken) surface on stderr, not as a crash.
 */
export function startArtifactServer(options: ArtifactServerOptions): Server {
  const { artifact, assets, io } = options;
  const root = resolve(assets);

  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");

    if (pathname === options.artifactRoute) {
      response.writeHead(200, {
        "content-type": "application/json",
        // The exact byte size, so the page's loading pipeline can show a
        // DETERMINATE progress bar while it streams the artifact in.
        "content-length": Buffer.byteLength(artifact, "utf8"),
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
        : `codegraph: the ${options.label} server failed: ${error.message}`,
    );
    server.close();
  });

  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    errLine(io, `${options.label} at http://localhost:${port}/ — Ctrl-C to stop.`);
  });

  return server;
}
