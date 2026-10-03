// THE THIRD-PARTY NOTICE of codegraph-metrics, generated: every crate the
// lockfile resolves, its declared license, and the license texts the crates
// themselves ship — identical texts printed once, under every crate that
// carries them. The binary embeds the result and prints it on `--licenses`.
//
//   cargo fetch --manifest-path extractors/metrics/Cargo.toml
//   node extractors/metrics/scripts/licenses.mjs > extractors/metrics/THIRD-PARTY-LICENSES.txt
//
// Regenerate after any dependency change; tests/fixtures.rs fails while a
// locked crate is missing from the file.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../Cargo.toml", import.meta.url));
const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const root = metadata.packages.find((p) => p.manifest_path === manifest);
const packages = metadata.packages
  .filter((p) => p !== root)
  .sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)([-._].*)?$/i;
const byText = new Map();
const lines = [];
/** License files at the crate's root, and inside a REUSE-style `LICENSES/` directory. */
function licenseFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!LICENSE_FILE.test(entry.name)) continue;
    if (entry.isFile()) found.push(entry.name);
    else if (entry.isDirectory()) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile()) found.push(join(entry.name, inner.name));
      }
    }
  }
  return found.sort();
}

for (const p of packages) {
  const dir = dirname(p.manifest_path);
  const files = licenseFiles(dir);
  const label = `${p.name} ${p.version}`;
  lines.push(`  ${label} — ${p.license ?? p.license_file ?? "no license declared"}${p.repository ? ` — ${p.repository}` : ""}`);
  if (files.length === 0) {
    const key = `(no license file in the published crate: ${p.license ?? "no license declared"} — its terms are those of that SPDX license)`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(label);
    continue;
  }
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(`${label} (${file})`);
  }
}

const mpl = packages.filter((p) => /MPL/.test(p.license ?? ""));
const out = [
  `Third-party software in codegraph-metrics ${root.version}`,
  "",
  "This binary links the crates below, unmodified. Those under the Mozilla Public",
  "License 2.0 are available in source form at:",
  ...mpl.map((p) => `  ${p.name} ${p.version}: https://crates.io/crates/${p.name}/${p.version}${p.repository ? ` (${p.repository})` : ""}`),
  "",
  `The ${packages.length} crates, with their declared licenses:`,
  ...lines,
  "",
  "Their license texts, each printed once, followed by the crates that ship it:",
];
for (const [text, owners] of byText) {
  out.push("", "=".repeat(78), ...owners.map((owner) => `  ${owner}`), "-".repeat(78), text);
}
process.stdout.write(`${out.join("\n")}\n`);
