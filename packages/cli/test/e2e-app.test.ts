import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cliBinary, ensureCliBinary, repoRoot } from "./cli-process.js";

/**
 * `codegraph serve --app` AS A PROCESS — what the shell (PLAN §15.4) does:
 * spawn it with stdin held open, read the ONE stdout line, use the URL, close
 * stdin and expect the child gone. Only a real child proves the two things
 * the in-process suite cannot: that stdout carries exactly that line through
 * the bundle and a real pipe, and that EOF on the real stdin ends the process.
 *
 * Needs the navigator-ui bundle built (`pnpm -r build`), as the classic
 * `serve` does: the daemon serves the same page.
 */
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children) child.kill();
  children.length = 0;
});

beforeAll(() => {
  ensureCliBinary();
});

interface Started {
  readonly child: ChildProcess;
  readonly port: number;
  readonly token: string;
  readonly stderr: () => string;
}

function start(extraArgs: readonly string[] = []): Promise<Started> {
  const dataDir = mkdtempSync(join(tmpdir(), "codegraph-e2e-app-"));
  const child = spawn(process.execPath, [cliBinary(), "serve", "--app", "--data-dir", dataDir, ...extraArgs], {
    cwd: repoRoot(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline === -1) return;
      const line = out.slice(0, newline);
      const announced = JSON.parse(line) as { port: number; token: string };
      resolve({ child, port: announced.port, token: announced.token, stderr: () => err });
    });
    child.once("exit", (code) => reject(new Error(`daemon exited early with ${code}: ${err}`)));
  });
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

describe("codegraph serve --app as a child process", () => {
  it("prints one JSON line, answers under the token, and exits 0 when stdin closes", async () => {
    const { child, port, token } = await start();
    const base = `http://127.0.0.1:${port}/${token}`;
    const app = await fetch(`${base}/app`);
    expect(app.status).toBe(200);
    expect(((await app.json()) as { kind: string }).kind).toBe("codegraph.app/1");
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<script");
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);

    // Nothing else on stdout, ever: the shell reads one line and stops listening.
    let more = "";
    child.stdout?.on("data", (chunk: string) => {
      more += chunk;
    });
    child.stdin?.end();
    const result = await exited(child);
    expect(result).toEqual({ code: 0, signal: null });
    expect(more).toBe("");
  }, 30_000);

  it("takes an extractor registry and describes it at /app", async () => {
    const registry = join(mkdtempSync(join(tmpdir(), "codegraph-e2e-reg-")), "registry.json");
    writeFileSync(
      registry,
      JSON.stringify([{ name: "java", path: join(repoRoot(), "packages/cli/test/fake-extractor.mjs"), extensions: [".java"] }]),
    );
    const { child, port, token } = await start(["--extractors", registry]);
    const app = (await (await fetch(`http://127.0.0.1:${port}/${token}/app`)).json()) as {
      extractors: { name: string }[];
    };
    expect(app.extractors.map((entry) => entry.name)).toEqual(["java"]);
    child.stdin?.end();
    expect((await exited(child)).code).toBe(0);
  }, 30_000);

  it("refuses a bad registry with exit 2 before binding anything", async () => {
    const registry = join(mkdtempSync(join(tmpdir(), "codegraph-e2e-reg-")), "registry.json");
    writeFileSync(registry, "[{\"name\":\"x\"}]");
    const dataDir = mkdtempSync(join(tmpdir(), "codegraph-e2e-app-"));
    const child = spawn(
      process.execPath,
      [cliBinary(), "serve", "--app", "--data-dir", dataDir, "--extractors", registry],
      { cwd: repoRoot(), stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(child);
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
    });
    const result = await exited(child);
    expect(result.code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("registry.json");
  }, 30_000);
});
