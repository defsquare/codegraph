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
//      then exits 0 when stdin closes;
//   4. `codegraph walk` answers from the image as from the ESM build: its two
//      built-in definitions (--print-definition) and a plan over the Java
//      fixture (--dry-run --json) — no provider, nothing written;
//   5. `codegraph insights --walk N` reads a walk's store — written here by the
//      insights package, no model — as the ESM build does: summary and --id.
//
//   node packages/cli/scripts/sea-smoke.mjs packages/cli/dist-sea/<rid>/codegraph[.exe]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** The same argv through the image and through the ESM build: exit 0 both, the same stdout. */
function sameAsEsm(args, label, expect = () => true) {
  const fromImage = spawnSync(image, args, { encoding: "utf8", cwd: ROOT });
  const fromEsm = spawnSync(process.execPath, [join(CLI_DIR, "dist", "index.js"), ...args], { encoding: "utf8", cwd: ROOT });
  check(
    fromImage.status === 0 && fromEsm.status === 0 && fromImage.stdout === fromEsm.stdout && expect(fromImage.stdout),
    `${label} answers from the image as from the ESM build (${fromImage.stdout.length} bytes)`,
    `image exit ${fromImage.status}, esm exit ${fromEsm.status}: ${fromImage.stderr.slice(0, 300)}`,
  );
}
const kindOf = (text) => {
  try {
    return JSON.parse(text).kind;
  } catch {
    return undefined;
  }
};

// 4. walk: the built-in definitions and a plan, no provider and nothing written (--no-cache, --dry-run)
sameAsEsm(["walk", "--print-definition"], "walk --print-definition", (out) => kindOf(out) === "codegraph.walk/1");
sameAsEsm(["walk", "--print-definition", "explain"], "walk --print-definition explain", (out) => kindOf(out) === "codegraph.walk/1");
sameAsEsm(
  ["walk", fixture, "--src", join(ROOT, "fixtures", "java", "src"), "--no-cache", "--prompt", "Where is state changed?", "--dry-run", "--json"],
  "walk --dry-run --json on the Java fixture",
  (out) => kindOf(out) === "codegraph.walkPlan/1",
);

// 5. insights --walk: a walk's store made by the insights package (the ESM build's own), read by both builds
const walkDir = mkdtempSync(join(tmpdir(), "codegraph-sea-walk-"));
try {
  const insights = await import(pathToFileURL(join(ROOT, "packages", "insights", "dist", "index.js")).href);
  const { loadSqlite } = await import(pathToFileURL(join(ROOT, "packages", "analyzer", "dist", "index.js")).href);
  const compiled = insights.compileDefinition(insights.parseWalkDefinition({ kind: "codegraph.walk/1", name: "smoke", answer: { fields: { type: { risky: "boolean" } } } }));
  const format = insights.walkRecords(compiled);
  const model = join(walkDir, "model.jsonl");
  writeFileSync(model, "never read: insights opens the store beside it\n");
  const store = insights.sqliteInsightsStore(loadSqlite().open(insights.walkStorePathFor(model, "smoke")), { format });
  const run = store.beginRun({
    header: {
      t: "header", kind: insights.WALK_RECORDS_KIND, walk: format.walk, generatedBy: insights.INSIGHTS_GENERATOR, promptVersion: insights.PROMPT_VERSION,
      models: { leaf: "m", rollup: "m" }, depth: 1, source: { paths: [], langs: [], view: { name: "all", filters: [] } },
    },
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  store.putUnit(run, "java:a/B", [{ t: "i", id: "java:a/B", level: "type", kind: "class", origin: "llm", fingerprint: "a".repeat(64), block: { answer: "No.", risky: false, description: "B.", confidence: 0.5 } }]);
  store.close();
  sameAsEsm(["insights", model, "--walk", "smoke"], "insights --walk smoke", (out) => out.includes("  walk: smoke, version 1") && out.includes("(1 answered)"));
  sameAsEsm(["insights", model, "--walk", "smoke", "--id", "java:a/B"], "insights --walk smoke --id", (out) => out.includes("walk smoke") && out.includes("risky: false"));
} catch (error) {
  check(false, "a walk's store is made and read", error instanceof Error ? error.message : String(error));
} finally {
  rmSync(walkDir, { recursive: true, force: true });
}

if (failures > 0) {
  process.stderr.write(`\n${failures} gate(s) failed for ${image}\n--- daemon stderr ---\n${stderr}\n`);
  process.exit(1);
}
process.stderr.write(`\nall gates passed for ${image}\n`);
