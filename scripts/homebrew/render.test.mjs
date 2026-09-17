// The tap's generated files (PLAN.md §15.5): run with `node --test scripts/homebrew`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { binaryFormulaRuby, caskRuby, nodeFormulaRuby, parseSums, renderTap } from "./render.mjs";

const HEX = (n) => String(n).repeat(64).slice(0, 64);
const SUMS = `${HEX(1)}  Codegraph-0.1.0-osx-arm64.dmg
${HEX(2)}  Codegraph-0.1.0-osx-x64.dmg
${HEX(3)}  codegraph-java-osx-arm64
${HEX(4)}  codegraph-java-osx-x64
${HEX(5)}  codegraph-java-linux-arm64
${HEX(6)}  codegraph-java-linux-x64
${HEX(7)}  codegraph-csharp-osx-arm64
${HEX(8)}  codegraph-csharp-osx-x64
${HEX(9)}  codegraph-csharp-linux-arm64
${HEX(0)}  codegraph-csharp-linux-x64
${HEX("a")}  codegraph-osx-arm64
`;

test("parseSums reads sha256sum output, star-marked or not", () => {
  const sums = parseSums(`${HEX(1)}  a.dmg\n${HEX(2)} *b\n\nnot a line\n`);
  assert.deepEqual(sums, { "a.dmg": HEX(1), b: HEX(2) });
});

test("the cask installs the app and ONE binary, one DMG per architecture, no auto-update", () => {
  const ruby = caskRuby({ version: "0.1.0", sums: parseSums(SUMS) });
  assert.match(ruby, /^cask "codegraph" do$/m);
  assert.match(ruby, /version "0\.1\.0"/);
  assert.match(ruby, /arch arm: "osx-arm64", intel: "osx-x64"/);
  assert.match(ruby, new RegExp(`sha256 arm:\\s+"${HEX(1)}",\\s+intel: "${HEX(2)}"`));
  assert.match(ruby, /url "https:\/\/github\.com\/defsquare\/codegraph\/releases\/download\/v#\{version\}\/Codegraph-#\{version\}-#\{arch\}\.dmg"/);
  assert.match(ruby, /app "Codegraph\.app"/);
  assert.equal((ruby.match(/^\s*binary /gm) ?? []).length, 1, "exactly one binary stanza");
  assert.match(ruby, /binary "#\{appdir\}\/Codegraph\.app\/Contents\/MacOS\/codegraph"/);
  assert.match(ruby, /auto_updates false/);
  assert.match(ruby, /strategy :github_latest/);
  assert.match(ruby, /do not edit by hand/);
});

test("a binary formula has the four platform blocks with their own URL and sum, and renames the asset", () => {
  const ruby = binaryFormulaRuby({ name: "java", version: "0.1.0", sums: parseSums(SUMS) });
  assert.match(ruby, /^class CodegraphJava < Formula$/m);
  assert.match(ruby, /version "0\.1\.0"/);
  for (const [rid, hex] of [["osx-arm64", HEX(3)], ["osx-x64", HEX(4)], ["linux-arm64", HEX(5)], ["linux-x64", HEX(6)]]) {
    assert.match(ruby, new RegExp(`url "https://github\\.com/defsquare/codegraph/releases/download/v0\\.1\\.0/codegraph-java-${rid}"\\n\\s+sha256 "${hex}"`));
  }
  assert.match(ruby, /on_macos do\n\s+on_arm do/);
  assert.match(ruby, /on_linux do\n\s+on_arm do/);
  assert.match(ruby, /bin\.install Dir\["codegraph-java-\*"\]\.first => "codegraph-java"/);
  assert.match(ruby, /system bin\/"codegraph-java", "--version"/);
  const csharp = binaryFormulaRuby({ name: "csharp", version: "0.1.0", sums: parseSums(SUMS) });
  assert.match(csharp, /^class CodegraphCsharp < Formula$/m);
  assert.match(csharp, /Hello\.cs/);
});

test("a missing sum is an error naming the asset, never a formula with a blank hash", () => {
  const withoutLinuxX64 = parseSums(SUMS.split("\n").filter((line) => !line.endsWith("codegraph-java-linux-x64")).join("\n"));
  assert.throws(
    () => binaryFormulaRuby({ name: "java", version: "0.1.0", sums: withoutLinuxX64 }),
    /no sha256 for codegraph-java-linux-x64/,
  );
  assert.throws(() => caskRuby({ version: "0.1.0", sums: {} }), /no sha256 for Codegraph-0\.1\.0-osx-arm64\.dmg/);
});

test("the TypeScript formula is the npm package on Homebrew's node", () => {
  const ruby = nodeFormulaRuby({ version: "0.1.0", sha256: HEX("b") });
  assert.match(ruby, /^class CodegraphTypescript < Formula$/m);
  assert.match(ruby, /url "https:\/\/registry\.npmjs\.org\/codegraph-typescript\/-\/codegraph-typescript-0\.1\.0\.tgz"/);
  assert.match(ruby, new RegExp(`sha256 "${HEX("b")}"`));
  assert.match(ruby, /depends_on "node"/);
  assert.match(ruby, /std_npm_args/);
  assert.match(ruby, /bin\.install_symlink Dir\["#\{libexec\}\/bin\/\*"\]/);
});

test("renderTap lists the cask and the formulae, the TypeScript one only with an npm sum", () => {
  const without = renderTap({ version: "0.1.0", sums: parseSums(SUMS) });
  assert.deepEqual(Object.keys(without).sort(), ["Casks/codegraph.rb", "Formula/codegraph-csharp.rb", "Formula/codegraph-java.rb"]);
  const withNpm = renderTap({ version: "0.1.0", sums: parseSums(SUMS), npmSha256: HEX("c") });
  assert.ok("Formula/codegraph-typescript.rb" in withNpm);
});

test("the CLI writes the files under --out", () => {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-tap-"));
  const sums = join(dir, "SHA256SUMS");
  writeFileSync(sums, SUMS);
  const script = fileURLToPath(new URL("./render.mjs", import.meta.url));
  execFileSync(process.execPath, [script, "--version", "0.1.0", "--sums", sums, "--npm-sha256", HEX("d"), "--out", join(dir, "tap")], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.deepEqual(readdirSync(join(dir, "tap")).sort(), ["Casks", "Formula"]);
  assert.deepEqual(readdirSync(join(dir, "tap", "Formula")).sort(), ["codegraph-csharp.rb", "codegraph-java.rb", "codegraph-typescript.rb"]);
  assert.match(readFileSync(join(dir, "tap", "Casks", "codegraph.rb"), "utf8"), /cask "codegraph"/);
});
