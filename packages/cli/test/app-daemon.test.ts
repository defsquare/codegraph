import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CityBuildOptions } from "../src/args.js";
import { createJobRunner, type JobEvent } from "../src/app/jobs.js";
import { startDaemon } from "../src/app/daemon.js";
import { type Registry } from "../src/app/registry.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { directoryAssets } from "../src/assets.js";

/**
 * `codegraph serve --app` — THE DAEMON behind the desktop app (PLAN §15.2),
 * exercised over real sockets against a fake extractor (test/fake-extractor.mjs)
 * and a fake frontend. What is under test is the contract the shell and the
 * page rely on: the one stdout line, the capability URL, the job routes, the
 * SSE stream, the cache under --data-dir, and dying with stdin.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE = join(HERE, "fake-extractor.mjs");
const JAVA_SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));
const JAVA_MODEL = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

const BUILD: CityBuildOptions & { noCache: boolean } = {
  height: "loc",
  heightScale: "linear",
  footprint: "members",
  footprintScale: "sqrt",
  carry: [],
  name: undefined,
  framework: undefined,
  internalOnly: false,
  declaredOnly: false,
  noCache: false,
};

function registry(env: Readonly<Record<string, string>> = {}): Registry {
  return [{ name: "java", path: FAKE, extensions: [".java"], launch: "node", env, install: undefined }];
}

const INSTALL_LINE = "brew install defsquare/tap/codegraph-elixir";
const ELIXIR_MISSING = { name: "elixir", path: null, extensions: [".ex"], launch: "exec", env: {}, install: INSTALL_LINE } as const;

function fakeAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-app-assets-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>fake navigator</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('ui')");
  return dir;
}

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "codegraph-app-src-"));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(root, relative, ".."), { recursive: true });
    writeFileSync(join(root, relative), content);
  }
  return root;
}

interface Daemon {
  readonly base: string;
  readonly token: string;
  readonly port: number;
  readonly io: CapturedIo;
  readonly server: Server;
  readonly dataDir: string;
  readonly stdin: PassThrough;
  readonly closed: Promise<void>;
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        }),
    ),
  );
});

async function daemon(options: { registry?: Registry | (() => Registry); dataDir?: string } = {}): Promise<Daemon> {
  const io = captureIo();
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "codegraph-app-data-"));
  const given = options.registry ?? registry();
  const reg = typeof given === "function" ? given : () => given;
  const runner = createJobRunner({ dataDir, registry: reg, build: BUILD, io });
  const stdin = new PassThrough();
  let onClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  const server = startDaemon({
    assets: directoryAssets(fakeAssets()),
    port: 0,
    host: "127.0.0.1",
    io,
    runner,
    registry: reg,
    dataDir,
    lifetime: { stdin, signals: false },
    onClose: () => onClose(),
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const lines = io.stdoutLines();
  const announced = JSON.parse(lines[0] ?? "{}") as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${announced.port}/${announced.token}`,
    token: announced.token,
    port: announced.port,
    io,
    server,
    dataDir,
    stdin,
    closed,
  };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Read the SSE stream until a terminal event; returns every event seen. */
async function events(base: string): Promise<JobEvent[]> {
  const response = await fetch(`${base}/jobs/current`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: JobEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (event === undefined || data === undefined) continue;
      seen.push({ event, data: JSON.parse(data) } as JobEvent);
      if (event === "done" || event === "failed") {
        await reader.cancel();
        return seen;
      }
    }
  }
  return seen;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the daemon's announcement and capability URL", () => {
  it("prints EXACTLY one JSON line on stdout — port and token — and nothing else", async () => {
    const { io, token, port } = await daemon();
    expect(io.stdoutLines()).toHaveLength(1);
    expect(JSON.parse(io.stdoutLines()[0]!)).toEqual({ port, token });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(port).toBeGreaterThan(0);
  });

  it("answers 404 — not 401 — outside /<token>/: the route does not exist", async () => {
    const { port, base } = await daemon();
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/navigator.json`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/${"0".repeat(32)}/app`)).status).toBe(404);
    expect((await fetch(`${base}/app`)).status).toBe(200);
  });

  it("redirects /<token> to /<token>/ so the page's relative fetches land under the token", async () => {
    const { base } = await daemon();
    const response = await fetch(base, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/${base.split("/").pop()}/`);
  });

  it("serves the frontend under the token, jailed to the assets directory", async () => {
    const { base } = await daemon();
    expect(await (await fetch(`${base}/`)).text()).toContain("fake navigator");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it("refuses a request whose Origin is not the page's own", async () => {
    const { base, port } = await daemon();
    expect((await post(base, { src: JAVA_SRC }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(`${base}/app`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/app`, { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    expect((await fetch(`${base}/app`, { headers: { origin: `http://localhost:${port}` } })).status).toBe(200);
  });

  it("describes itself at /app: the registry as names and extensions, no current project yet", async () => {
    const { base } = await daemon();
    expect(await json(await fetch(`${base}/app`))).toEqual({
      kind: "codegraph.app/1",
      extractors: [{ name: "java", extensions: [".java"], installed: true }],
      current: null,
    });
    expect(await json(await fetch(`${base}/recent`))).toEqual({ kind: "codegraph.recent/1", projects: [] });
    expect((await fetch(`${base}/navigator.json`)).status).toBe(404);
    expect((await fetch(`${base}/city.json`)).status).toBe(404);
  });
});

describe("POST /jobs: a folder becomes the page", () => {
  it("detects the extractor, runs it with progress on the SSE route, builds both artifacts", async () => {
    const { base, dataDir } = await daemon();
    const accepted = await post(base, { src: JAVA_SRC });
    expect(accepted.status).toBe(202);
    expect(await json(accepted)).toEqual({
      job: { src: JAVA_SRC, name: "src", extractor: "java" },
    });

    const seen = await events(base);
    const kinds = seen.map((event) => event.event);
    expect(kinds[0]).toBe("started");
    expect(kinds.at(-1)).toBe("done");
    const phases = seen.filter((event) => event.event === "phase").map((event) => (event.data as { phase: string }).phase);
    expect(phases).toEqual(["detect", "extract", "build"]);
    const progress = seen.filter((event) => event.event === "progress").map((event) => (event.data as { line: string }).line);
    expect(progress).toEqual([expect.stringContaining("fake: scanning"), "fake: 3 files, 179 entities"]);

    const navigator = await fetch(`${base}/navigator.json`);
    expect(navigator.status).toBe(200);
    expect(navigator.headers.get("content-length")).not.toBeNull();
    expect((await json<{ kind: string }>(navigator)).kind).toBe("codegraph.navigator/1");
    const city = await json<{ kind: string; layout?: unknown }>(await fetch(`${base}/city.json`));
    expect(city.kind).toBe("codegraph.city/1");
    expect(city.layout).toBeDefined();

    // Everything lives under --data-dir: the model, its store, the artifacts.
    const projects = readFileSync(join(dataDir, "recent.json"), "utf8");
    expect(JSON.parse(projects)).toMatchObject({
      kind: "codegraph.recent/1",
      projects: [{ src: JAVA_SRC, name: "src", extractor: "java" }],
    });
    const modelsDir = join(dataDir, "models");
    expect(existsSync(modelsDir)).toBe(true);
    const app = await json<{ current: { src: string; state: string } }>(await fetch(`${base}/app`));
    expect(app.current).toMatchObject({ src: JAVA_SRC, state: "done" });
  });

  it("skips the extractor when the tree is unchanged, and says so", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "codegraph-app-log-")), "runs.log");
    const { base } = await daemon({ registry: registry({ FAKE_EXTRACTOR_LOG: log }) });
    expect((await post(base, { src: JAVA_SRC })).status).toBe(202);
    await events(base);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

    expect((await post(base, { src: JAVA_SRC })).status).toBe(202);
    const second = await events(base);
    expect(second.at(-1)?.event).toBe("done");
    const extract = second.find((event) => event.event === "phase" && (event.data as { phase: string }).phase === "extract");
    expect((extract?.data as { detail: string }).detail).toContain("unchanged");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("re-runs the extractor when a claimed file changed", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "codegraph-app-log-")), "runs.log");
    const src = tree({ "A.java": "class A {}" });
    const { base } = await daemon({ registry: registry({ FAKE_EXTRACTOR_LOG: log }) });
    expect((await post(base, { src })).status).toBe(202);
    await events(base);
    writeFileSync(join(src, "A.java"), "class A { int x; }");
    expect((await post(base, { src })).status).toBe(202);
    await events(base);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("answers 409 while a job runs — one at a time", async () => {
    const { base } = await daemon({ registry: registry({ FAKE_EXTRACTOR_SLOW_MS: "1500" }) });
    expect((await post(base, { src: JAVA_SRC })).status).toBe(202);
    const busy = await post(base, { src: JAVA_SRC });
    expect(busy.status).toBe(409);
    expect(await json(busy)).toEqual({ error: "busy", job: { src: JAVA_SRC, name: "src", extractor: "java" } });
    await events(base);
  });

  it("reports an extractor failure with its exit code and last stderr lines; the page keeps what it had", async () => {
    const { base } = await daemon({ registry: registry({ FAKE_EXTRACTOR_FAIL: "1" }) });
    expect((await post(base, { src: JAVA_SRC })).status).toBe(202);
    const seen = await events(base);
    const failed = seen.at(-1);
    expect(failed?.event).toBe("failed");
    expect(failed?.data).toMatchObject({
      exitCode: 1,
      stderr: expect.arrayContaining(["fake: cannot parse src/Broken.java"]),
    });
    expect((await fetch(`${base}/navigator.json`)).status).toBe(404);
    const app = await json<{ current: { state: string } }>(await fetch(`${base}/app`));
    expect(app.current.state).toBe("failed");
  });

  it("opens a model.jsonl directly — no extractor involved", async () => {
    const { base } = await daemon({ registry: [] });
    const accepted = await post(base, { src: JAVA_MODEL });
    expect(accepted.status).toBe(202);
    expect(await json(accepted)).toEqual({ job: { src: JAVA_MODEL, name: "model", extractor: null } });
    const seen = await events(base);
    expect(seen.at(-1)?.event).toBe("done");
    expect(seen.some((event) => event.event === "phase" && (event.data as { phase: string }).phase === "extract")).toBe(false);
    expect((await fetch(`${base}/navigator.json`)).status).toBe(200);
  });

  it("answers not-installed with the install line when the tree's extractor is known but absent", async () => {
    const src = tree({ "lib/a.ex": "", "lib/b.ex": "" });
    const { base } = await daemon({ registry: [...registry(), ELIXIR_MISSING] });
    const response = await post(base, { src });
    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({
      error: "not-installed",
      extractors: [{ name: "elixir", files: 2, install: INSTALL_LINE }],
    });
    const app = await json<{ extractors: unknown[] }>(await fetch(`${base}/app`));
    expect(app.extractors).toEqual([
      { name: "java", extensions: [".java"], installed: true },
      { name: "elixir", extensions: [".ex"], installed: false, install: INSTALL_LINE },
    ]);
  });

  it("asks the registry again on every request — the shell rewrites it after a rescan", async () => {
    const src = tree({ "lib/a.ex": "" });
    let current: Registry = [ELIXIR_MISSING];
    const { base } = await daemon({ registry: () => current });
    expect((await post(base, { src })).status).toBe(422);
    // "Installed" now: the same request, with no restart, runs it.
    current = [{ ...ELIXIR_MISSING, path: FAKE, launch: "node", install: undefined }];
    expect((await post(base, { src })).status).toBe(202);
    expect((await events(base)).at(-1)?.event).toBe("done");
    expect((await json<{ extractors: { installed: boolean }[] }>(await fetch(`${base}/app`))).extractors[0]?.installed).toBe(true);
  });

  it("asks when several extractors claim the tree, and takes the answer", async () => {
    const src = tree({ "A.java": "", "B.cs": "", "C.cs": "" });
    const both: Registry = [
      { name: "java", path: FAKE, extensions: [".java"], launch: "node", env: {}, install: undefined },
      { name: "csharp", path: FAKE, extensions: [".cs"], launch: "node", env: {}, install: undefined },
    ];
    const { base } = await daemon({ registry: both });
    const asked = await post(base, { src });
    expect(asked.status).toBe(422);
    expect(await json(asked)).toEqual({
      error: "ambiguous",
      candidates: [
        { name: "csharp", files: 2 },
        { name: "java", files: 1 },
      ],
    });
    const answered = await post(base, { src, extractor: "java" });
    expect(answered.status).toBe(202);
    expect((await events(base)).at(-1)?.event).toBe("done");
  });

  it("says when no registered extractor claims anything, naming what is there", async () => {
    const src = tree({ "a.py": "", "b.rb": "" });
    const { base } = await daemon();
    const response = await post(base, { src });
    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({ error: "no-extractor", seen: [".py", ".rb"] });
  });

  it("rejects an unknown extractor name, a missing folder and a malformed body", async () => {
    const { base } = await daemon();
    const unknown = await post(base, { src: JAVA_SRC, extractor: "go" });
    expect(unknown.status).toBe(422);
    expect(await json(unknown)).toEqual({ error: "unknown-extractor", name: "go" });
    const missing = await post(base, { src: "/nonexistent/folder" });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: "not-found", src: "/nonexistent/folder" });
    const notModel = await post(base, { src: FAKE });
    expect(notModel.status).toBe(422);
    expect(await json(notModel)).toEqual({ error: "not-a-model", src: FAKE });
    expect((await post(base, "{not json")).status).toBe(400);
    expect((await post(base, { nope: 1 })).status).toBe(400);
  });

  it("allows only GET/HEAD on the artifact routes and POST on /jobs", async () => {
    const { base } = await daemon();
    expect((await fetch(`${base}/navigator.json`, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(`${base}/jobs`, { method: "GET" })).status).toBe(405);
  });
});

describe("the SSE route with no job", () => {
  it("sends idle and stays open — the page subscribes once, before the shell opens anything", async () => {
    const { base } = await daemon();
    const controller = new AbortController();
    const response = await fetch(`${base}/jobs/current`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: idle");
    controller.abort();
  });
});

describe("the daemon dies with its parent", () => {
  it("closes when stdin reaches EOF", async () => {
    const { stdin, closed, base } = await daemon();
    expect((await fetch(`${base}/app`)).status).toBe(200);
    stdin.end();
    await closed;
    await expect(fetch(`${base}/app`)).rejects.toThrow();
  });
});
