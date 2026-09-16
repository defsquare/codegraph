import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { directoryAssets, keyedAssets, relativeOfRoute, type FrontendAssets } from "../src/assets.js";
import { captureIo } from "../src/io.js";
import { startArtifactServer } from "../src/serve.js";
import { isSeaImage, nodeCommand, seaAsset } from "../src/sea.js";
import { versionOf } from "../src/version.js";

/**
 * ONE SEAM, TWO SOURCES (PLAN §15.3): a frontend's files come from a
 * directory in a checkout and from the image's assets in the single
 * executable. The server cannot tell which answered, so the same requests
 * are made of both here — the directory source over real files, the keyed
 * source over a map standing in for `node:sea`'s `getAsset` (the real one is
 * exercised by scripts/sea-smoke.mjs against a built image).
 */
const FILES: Readonly<Record<string, string>> = {
  "index.html": "<!doctype html><title>bundle</title>",
  "assets/app.js": "console.log('app')",
  "assets/app.css": "body{}",
};

function directory(): FrontendAssets {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-assets-"));
  for (const [relative, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, relative, ".."), { recursive: true });
    writeFileSync(join(dir, relative), text);
  }
  return directoryAssets(dir);
}

function keyed(): FrontendAssets {
  const store = new Map(Object.entries(FILES).map(([relative, text]) => [`ui/${relative}`, Buffer.from(text)]));
  return keyedAssets("sea:ui", "ui", (key) => store.get(key));
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
});

async function serve(assets: FrontendAssets): Promise<string> {
  const server = startArtifactServer({
    routes: { "/city.json": "{}" },
    label: "test",
    assets,
    port: 0,
    host: "127.0.0.1",
    io: captureIo(),
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

describe.each([
  ["a directory", directory],
  ["keyed assets (the image)", keyed],
])("frontend assets from %s", (_label, make) => {
  it("reads the index and nested files, and nothing for a missing path", () => {
    const assets = make();
    expect(assets.read("index.html")?.toString()).toBe(FILES["index.html"]);
    expect(assets.read("assets/app.js")?.toString()).toBe(FILES["assets/app.js"]);
    expect(assets.read("assets/nope.js")).toBeUndefined();
  });

  it("refuses a traversal", () => {
    const assets = make();
    expect(assets.read("../secret")).toBeUndefined();
    expect(assets.read("assets/../../secret")).toBeUndefined();
  });

  it("serves the same bytes with the same MIME types through the server", async () => {
    const base = await serve(make());
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toBe(FILES["index.html"]);
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toBe(FILES["assets/app.js"]);
    expect((await fetch(`${base}/assets/app.css`)).headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });
});

describe("relativeOfRoute", () => {
  it("maps the mount root to the index and strips leading slashes", () => {
    expect(relativeOfRoute("/")).toBe("index.html");
    expect(relativeOfRoute("")).toBe("index.html");
    expect(relativeOfRoute("/assets/app.js")).toBe("assets/app.js");
    expect(relativeOfRoute("//assets//app.js")).toBe("assets/app.js");
  });
});

describe("the image's facts, from a checkout", () => {
  it("is not the image: no assets, and node is this process", () => {
    expect(isSeaImage()).toBe(false);
    expect(seaAsset("package.json")).toBeUndefined();
    expect(nodeCommand()).toBe(process.execPath);
  });
});

describe("versionOf", () => {
  it("reads the version field and falls back for anything else", () => {
    expect(versionOf(`{"name":"x","version":"1.2.3"}`)).toBe("1.2.3");
    expect(versionOf(`{"name":"x"}`)).toBe("0.0.0-unknown");
    expect(versionOf("not json")).toBe("0.0.0-unknown");
    expect(versionOf(undefined)).toBe("0.0.0-unknown");
  });
});
