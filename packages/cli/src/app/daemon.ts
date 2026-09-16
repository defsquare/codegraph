import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { errLine, type IoSink } from "../io.js";
import { bindFailure, sendJson, serveStatic, type FrontendAssets } from "../serve.js";
import type { JobRunner } from "./jobs.js";
import type { Registry } from "./registry.js";
import { RECENT_KIND, readRecent } from "./store.js";

/**
 * `codegraph serve --app`: THE DAEMON behind the desktop app (PLAN §15.2).
 *
 * A CAPABILITY URL, NOT AN OPEN PORT. Every route lives under `/<token>/`,
 * the token is minted per launch and printed once, on stdout, as the single
 * JSON line `{"port":N,"token":"…"}` the shell reads; anything outside it is
 * a 404 (the route does not exist — never a 401 that confirms there is
 * something to guess at). A code model is sensitive, and on loopback any page
 * in any browser could otherwise read it; the `Origin` header, when a browser
 * sends one, must be the page's own.
 *
 * IT DIES WITH ITS PARENT. Stdin EOF closes the server and kills a running
 * extractor, so a shell that crashed cannot leave an orphan holding a model
 * in memory and a port open. SIGTERM does the same; the shell uses both.
 *
 * THE PAGE IS THE SAME PAGE. The frontend bundle is served under the token
 * with relative URLs, so `navigator.json` and `city.json` are fetched exactly
 * as `codegraph serve` hands them out today — no Tauri IPC, no CORS.
 */
export const APP_KIND = "codegraph.app/1";

export interface DaemonOptions {
  /** The frontend's static bundle (navigatorAssets()). */
  readonly assets: FrontendAssets;
  /** 0 = ephemeral, the shell's choice; the actual port goes in the stdout line. */
  readonly port: number;
  readonly host: string;
  readonly io: IoSink;
  readonly runner: JobRunner;
  readonly registry: Registry;
  /** Where the recents file lives. */
  readonly dataDir: string;
  /** What ends the daemon: the shell's stdin (EOF) and the process signals. Tests inject both. */
  readonly lifetime?: {
    readonly stdin?: NodeJS.ReadableStream | undefined;
    readonly signals?: boolean;
  };
  /** Called once the server has closed — the process exits on its own when nothing else is pending. */
  readonly onClose?: () => void;
}

/** 32 hex characters: 128 bits, unguessable, typeable in a URL. */
export function mintToken(): string {
  return randomBytes(16).toString("hex");
}

const MAX_BODY_BYTES = 64 * 1024;

/** Origins that ARE the page, for a browser that sends the header. */
function ownOrigins(host: string, port: number): ReadonlySet<string> {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  origins.add(`http://${host}:${port}`);
  return origins;
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", () => resolve(undefined));
  });
}

export function startDaemon(options: DaemonOptions): Server {
  const { io, runner, registry } = options;
  const token = mintToken();
  const prefix = `/${token}`;
  let port = options.port;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const pathname = decodeURIComponent(url.split("?")[0] ?? "/");

    const origin = request.headers.origin;
    if (origin !== undefined && !ownOrigins(options.host, port).has(origin)) {
      response.writeHead(403).end();
      return;
    }

    if (pathname === prefix) {
      response.writeHead(302, { location: `${prefix}/` }).end();
      return;
    }
    if (!pathname.startsWith(`${prefix}/`)) {
      response.writeHead(404).end();
      return;
    }
    const route = pathname.slice(prefix.length);

    switch (route) {
      case "/app": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
        const current = runner.current;
        sendJson(response, 200, JSON.stringify({
          kind: APP_KIND,
          extractors: registry.map((entry) => ({ name: entry.name, extensions: entry.extensions })),
          current: current === undefined ? null : { ...current.job, state: current.state },
        }), method);
        return;
      }
      case "/recent": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
        const recent = readRecent(options.dataDir);
        sendJson(response, 200, JSON.stringify({ kind: RECENT_KIND, projects: recent.projects }), method);
        return;
      }
      case "/navigator.json":
      case "/city.json": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
        const artifacts = runner.artifacts;
        if (artifacts === undefined) {
          response.writeHead(404).end();
          return;
        }
        sendJson(response, 200, route === "/navigator.json" ? artifacts.navigator : artifacts.city, method);
        return;
      }
      case "/jobs": {
        if (method !== "POST") return methodNotAllowed(response, "POST");
        const body = await readBody(request);
        let parsed: unknown;
        try {
          parsed = body === undefined ? undefined : JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        const src = typeof parsed === "object" && parsed !== null ? (parsed as { src?: unknown }).src : undefined;
        const extractor = typeof parsed === "object" && parsed !== null ? (parsed as { extractor?: unknown }).extractor : undefined;
        if (typeof src !== "string" || src.length === 0 || (extractor !== undefined && typeof extractor !== "string")) {
          sendJson(response, 400, JSON.stringify({ error: "bad-request", expected: { src: "string", extractor: "string?" } }));
          return;
        }
        const outcome = runner.start({ src, extractor });
        switch (outcome.kind) {
          case "accepted":
            return sendJson(response, 202, JSON.stringify({ job: outcome.job }));
          case "busy":
            return sendJson(response, 409, JSON.stringify({ error: "busy", job: outcome.job }));
          case "not-found":
            return sendJson(response, 404, JSON.stringify({ error: "not-found", src: outcome.src }));
          case "not-a-model":
            return sendJson(response, 422, JSON.stringify({ error: "not-a-model", src: outcome.src }));
          case "ambiguous":
            return sendJson(response, 422, JSON.stringify({ error: "ambiguous", candidates: outcome.candidates }));
          case "no-extractor":
            return sendJson(response, 422, JSON.stringify({ error: "no-extractor", seen: outcome.seen }));
          case "unknown-extractor":
            return sendJson(response, 422, JSON.stringify({ error: "unknown-extractor", name: outcome.name }));
        }
        return;
      }
      case "/jobs/current": {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        if (runner.current === undefined) response.write("event: idle\ndata: {}\n\n");
        const unsubscribe = runner.subscribe((event) => {
          response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        });
        request.once("close", unsubscribe);
        return;
      }
      default:
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET, HEAD");
        serveStatic(options.assets, route, method, response);
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    errLine(io, bindFailure(error, options.host, { port: options.port, label: "codegraph app daemon" }));
    server.close();
  });

  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    errLine(io, `codegraph app daemon: ${reason}; shutting down.`);
    runner.shutdown();
    server.closeAllConnections();
    server.close(() => options.onClose?.());
  };

  server.listen(options.port, options.host, () => {
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : options.port;
    // THE line the shell reads. Stdout carries nothing else, ever.
    io.out(`${JSON.stringify({ port, token })}\n`);
    errLine(io, `codegraph app daemon at http://${options.host}:${port}${prefix}/ — exits when stdin closes.`);

    const stdin = options.lifetime?.stdin;
    if (stdin !== undefined) {
      stdin.once("end", () => shutdown("stdin closed"));
      stdin.once("close", () => shutdown("stdin closed"));
      stdin.resume();
    }
    if (options.lifetime?.signals ?? true) {
      process.once("SIGTERM", () => shutdown("SIGTERM"));
      process.once("SIGINT", () => shutdown("SIGINT"));
    }
  });

  return server;
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { allow }).end();
}
