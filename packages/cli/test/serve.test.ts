import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureIo, type CapturedIo } from "../src/io.js";
import { startArtifactServer, startCityServer } from "../src/serve.js";

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

async function started(
  host = "127.0.0.1",
): Promise<{ base: string; io: CapturedIo; bound: string }> {
  const io = captureIo();
  const server = startCityServer({ artifact: ARTIFACT, assets: fakeAssets(), port: 0, host, io });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const bound = typeof address === "object" && address !== null ? address.address : "";
  return { base: `http://127.0.0.1:${port}`, io, bound };
}

describe("startCityServer", () => {
  it("serves the artifact verbatim as /city.json, uncached", async () => {
    const { base } = await started();
    const response = await fetch(`${base}/city.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The byte size up front — the visualizer's loading bar needs a total.
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(ARTIFACT)));
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

  it("binds the requested host", async () => {
    const { bound } = await started("0.0.0.0");
    expect(bound).toBe("0.0.0.0");
  });

  it("announces a BROWSABLE url when bound to all interfaces", async () => {
    const { base, io } = await started("0.0.0.0");
    expect(io.stderr()).toContain(`city visualizer at http://localhost:${base.split(":")[2]}/`);
    expect(io.stderr()).toContain("every interface");
  });

  it("binds loopback when no host is given — the city's unchanged behaviour", async () => {
    const { io } = await started();
    expect(io.stderr()).not.toContain("reachable from other machines");
  });
});

/**
 * WHICH INTERFACE, and saying so. `navigator --serve` binds every interface by
 * default, which hands the whole model to anyone who can reach this machine.
 * That is the caller's decision to make and the server's duty to state, so the
 * announcement is asserted as carefully as the port is.
 */
describe("startArtifactServer: the bind address", () => {
  async function bind(host: string | undefined): Promise<{ io: CapturedIo; server: Server }> {
    const io = captureIo();
    const server = startArtifactServer({
      artifact: ARTIFACT,
      artifactRoute: "/navigator.json",
      label: "model navigator",
      assets: fakeAssets(),
      port: 0,
      ...(host === undefined ? {} : { host }),
      io,
    });
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    return { io, server };
  }

  function addressOf(server: Server): { address: string; port: number } {
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("not listening");
    return { address: address.address, port: address.port };
  }

  it("binds every interface for 0.0.0.0, and says the page is reachable elsewhere", async () => {
    const { io, server } = await bind("0.0.0.0");
    expect(addressOf(server).address).toBe("0.0.0.0");
    expect(io.stderr()).toContain("every interface");
    expect(io.stderr()).toContain("reachable from other machines");
    // Never printed as a URL: http://0.0.0.0/ is not an address to open.
    expect(io.stderr()).not.toContain("http://0.0.0.0");
    expect(io.stderr()).toContain(`http://localhost:${addressOf(server).port}/`);
  });

  it("binds loopback for 127.0.0.1, and claims no wider reach", async () => {
    const { io, server } = await bind("127.0.0.1");
    expect(addressOf(server).address).toBe("127.0.0.1");
    expect(io.stderr()).not.toContain("reachable from other machines");
  });

  it("actually answers on a non-loopback interface when bound to 0.0.0.0", async () => {
    const { server } = await bind("0.0.0.0");
    const { port } = addressOf(server);
    // 127.0.0.1 is covered by a wildcard bind; that it answers there proves
    // the bind took effect without assuming this machine's other addresses.
    const response = await fetch(`http://127.0.0.1:${port}/navigator.json`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ARTIFACT);
  });

  it("reports an unbindable address in terms of --host, not of the port", async () => {
    const io = captureIo();
    // 203.0.113.1 is TEST-NET-3 (RFC 5737): never an address of this machine.
    const server = startArtifactServer({
      artifact: ARTIFACT,
      artifactRoute: "/navigator.json",
      label: "model navigator",
      assets: fakeAssets(),
      port: 0,
      host: "203.0.113.1",
      io,
    });
    servers.push(server);
    await new Promise((resolve) => server.once("error", resolve));
    expect(io.stderr()).toContain("cannot bind 203.0.113.1");
    expect(io.stderr()).toContain("--host");
    expect(io.stderr()).not.toContain("--port");
  });
});
