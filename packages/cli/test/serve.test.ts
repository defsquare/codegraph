import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureIo, type CapturedIo } from "../src/io.js";
import { startCityServer } from "../src/serve.js";

/**
 * The real server, on a real ephemeral port, against a FAKE assets directory —
 * what is under test is byte movement and the jail, not the visualizer.
 */
const ARTIFACT = `{"kind":"codegraph.city/1","districts":[]}`;

function fakeAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-serve-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>fake viz</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('viz')");
  return dir;
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

async function started(): Promise<{ base: string; io: CapturedIo }> {
  const io = captureIo();
  const server = startCityServer({ artifact: ARTIFACT, assets: fakeAssets(), port: 0, io });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, io };
}

describe("startCityServer", () => {
  it("serves the artifact verbatim as /city.json, uncached", async () => {
    const { base } = await started();
    const response = await fetch(`${base}/city.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(ARTIFACT);
  });

  it("serves the visualizer's index at / and nested assets by path", async () => {
    const { base } = await started();
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("fake viz");
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
  });

  it("answers 404 for a missing file and for path traversal", async () => {
    const { base } = await started();
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it("allows only GET and HEAD", async () => {
    const { base } = await started();
    const response = await fetch(`${base}/city.json`, { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
  });

  it("announces the ACTUAL port on stderr once listening", async () => {
    const { base, io } = await started();
    expect(io.stderr()).toContain(`city visualizer at http://localhost:${base.split(":")[2]}/`);
    expect(io.stderr()).toContain("Ctrl-C to stop");
  });
});
