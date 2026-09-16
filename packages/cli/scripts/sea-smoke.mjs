// The single-executable image's acceptance gates (PLAN §15.3), run by
// test.sh --sea and by the CI `sea` matrix on every runner:
//
//   1. `codegraph --version` prints packages/cli/package.json's version — the
//      asset path of version.ts, not the fallback;
//   2. `codegraph analyze` on the Java fixture is byte-identical to what the
//      ESM build prints — one CLI, two builds;
//   3. `codegraph serve --app` under the fake extractor answers the page from
//      the image's assets (index.html and the script it references), opens
//      fixtures/java/src, and hands out /<token>/navigator.json and city.json;
//      then exits 0 when stdin closes.
//
//   node packages/cli/scripts/sea-smoke.mjs packages/cli/dist-sea/<rid>/codegraph[.exe]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(CLI_DIR, "..", "..");
const image = process.argv[2];
if (image === undefined) {
  process.stderr.write("usage: sea-smoke.mjs <codegraph image>\n");
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = "") => {
  process.stderr.write(`${ok ? "✓" : "✗"} ${label}${ok || detail === "" ? "" : ` — ${detail}`}\n`);
  if (!ok) failures += 1;
};

// 1. --version
const version = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")).version;
const versionRun = spawnSync(image, ["--version"], { encoding: "utf8" });
check(versionRun.status === 0 && versionRun.stdout.trim() === version, `--version prints ${version}`, `got '${versionRun.stdout.trim()}' (exit ${versionRun.status}) ${versionRun.stderr}`);

// 2. analyze, byte-identical to the ESM build
const fixture = join(ROOT, "fixtures", "java", "expected", "model.jsonl");
for (const report of ["deps", "cycles", "coupling"]) {
  const args = ["analyze", fixture, "--report", report, "--no-cache"];
  const fromImage = spawnSync(image, args, { encoding: "utf8", cwd: ROOT });
  const fromEsm = spawnSync(process.execPath, [join(CLI_DIR, "dist", "index.js"), ...args], { encoding: "utf8", cwd: ROOT });
  check(
    fromImage.status === 0 && fromImage.status === fromEsm.status && fromImage.stdout === fromEsm.stdout && fromImage.stdout.length > 0,
    `analyze --report ${report} is byte-identical to the ESM build (${fromImage.stdout.length} bytes)`,
    `image exit ${fromImage.status}: ${fromImage.stderr.slice(0, 300)}`,
  );
}

// 3. serve --app from the image's own assets
const dataDir = mkdtempSync(join(tmpdir(), "codegraph-sea-smoke-"));
const registry = join(dataDir, "registry.json");
writeFileSync(
  registry,
  JSON.stringify([{ name: "java", path: join(CLI_DIR, "test", "fake-extractor.mjs"), extensions: [".java"], launch: "node" }]),
);
const daemon = spawn(image, ["serve", "--app", "--data-dir", dataDir, "--extractors", registry], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
daemon.stderr.setEncoding("utf8");
daemon.stderr.on("data", (chunk) => (stderr += chunk));
const announced = await new Promise((resolvePromise, reject) => {
  let out = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stdout.on("data", (chunk) => {
    out += chunk;
    const newline = out.indexOf("\n");
    if (newline !== -1) resolvePromise(JSON.parse(out.slice(0, newline)));
  });
  daemon.once("exit", (code) => reject(new Error(`daemon exited early (${code}): ${stderr}`)));
  setTimeout(() => reject(new Error(`no stdout line within 20 s: ${stderr}`)), 20_000);
}).catch((error) => {
  check(false, "the daemon announces its port and token", error.message);
  return undefined;
});

if (announced !== undefined) {
  const base = `http://127.0.0.1:${announced.port}/${announced.token}`;
  check((await fetch(`http://127.0.0.1:${announced.port}/`)).status === 404, "outside the token is 404");
  const index = await fetch(`${base}/`);
  const html = await index.text();
  check(index.status === 200 && html.includes("<script"), "the page's index.html comes from the image");
  const script = html.match(/src="\.?\/?(assets\/[^"]+\.js)"/)?.[1];
  const scriptResponse = script === undefined ? undefined : await fetch(`${base}/${script}`);
  check(
    scriptResponse !== undefined && scriptResponse.status === 200 && (scriptResponse.headers.get("content-type") ?? "").includes("javascript"),
    `the page's script ${script ?? "(none referenced)"} comes from the image`,
  );
  const app = await fetch(`${base}/app`);
  check(app.status === 200 && (await app.json()).kind === "codegraph.app/1", "/app describes the daemon");

  const accepted = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ src: join(ROOT, "fixtures", "java", "src") }),
  });
  check(accepted.status === 202, "POST /jobs on fixtures/java/src is accepted", `HTTP ${accepted.status}`);

  const stream = await fetch(`${base}/jobs/current`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal;
  const deadline = Date.now() + 60_000;
  while (terminal === undefined && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split("\n\n")) {
      const event = block.match(/^event: (.*)$/m)?.[1];
      if (event === "done" || event === "failed") terminal = { event, data: block.match(/^data: (.*)$/m)?.[1] };
    }
  }
  await reader.cancel().catch(() => {});
  check(terminal?.event === "done", "the job ends with done", `${terminal?.event ?? "no terminal event"}: ${terminal?.data ?? ""}`);

  const navigator = await fetch(`${base}/navigator.json`);
  check(navigator.status === 200 && (await navigator.json()).kind === "codegraph.navigator/1", "navigator.json is served");
  const city = await fetch(`${base}/city.json`);
  const cityBody = await city.json().catch(() => ({}));
  check(city.status === 200 && cityBody.kind === "codegraph.city/1" && cityBody.layout !== undefined, "city.json is served, laid out");

  daemon.stdin.end();
  const exit = await new Promise((resolvePromise) => {
    daemon.once("exit", (code) => resolvePromise(code));
    setTimeout(() => resolvePromise("timeout"), 10_000);
  });
  check(exit === 0, "the daemon exits 0 when stdin closes", `exit ${exit}`);
}

if (failures > 0) {
  process.stderr.write(`\n${failures} gate(s) failed for ${image}\n--- daemon stderr ---\n${stderr}\n`);
  process.exit(1);
}
process.stderr.write(`\nall gates passed for ${image}\n`);
