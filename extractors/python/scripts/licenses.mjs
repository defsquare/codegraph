// THE THIRD-PARTY NOTICE of codegraph-python, generated: every crate the
// lockfile resolves, its declared license and the license texts the crates
// ship (a crate of a git checkout without its own: the checkout's — Ruff's
// crates carry theirs at the repository's root), identical texts printed once;
// then the DATA the binary embeds — the standard-library table distilled from
// typeshed (data/typeshed-LICENSE: Apache-2.0, parts MIT) and the Python 2 name
// lists. The binary embeds the result and prints it on `--licenses`.
//
//   cargo fetch --locked --manifest-path extractors/python/Cargo.toml
//   node extractors/python/scripts/licenses.mjs > extractors/python/THIRD-PARTY-LICENSES.txt
//
// Regenerate after any dependency or data change; tests/contract.rs fails while
// a locked crate is missing from the file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../Cargo.toml", import.meta.url));
const data = fileURLToPath(new URL("../data/", import.meta.url));
const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const root = metadata.packages.find((p) => p.manifest_path === manifest);
// The codegraph crates (path dependencies: the shared writer) are this project's own.
const packages = metadata.packages
  .filter((p) => p !== root && p.source !== null)
  .sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)([-._].*)?$/i;
/** License files at a directory's root, and inside a REUSE-style `LICENSES/` directory. */
function licenseFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!LICENSE_FILE.test(entry.name)) continue;
    if (entry.isFile()) found.push(join(dir, entry.name));
    else if (entry.isDirectory()) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile()) found.push(join(dir, entry.name, inner.name));
      }
    }
  }
  return found.sort();
}
/** A git dependency's crate without its own texts: the checkout's, nearest first. */
function gitLicenseFiles(dir) {
  for (let at = dirname(dir); at !== dirname(at); at = dirname(at)) {
    const files = licenseFiles(at);
    if (files.length > 0) return files;
    if (existsSync(join(at, ".git")) || /\/git\/checkouts\/[^/]+\/[^/]+$/.test(at)) break;
  }
  return [];
}

const byText = new Map();
const lines = [];
const keep = (text, owner) => {
  if (!byText.has(text)) byText.set(text, []);
  byText.get(text).push(owner);
};
for (const p of packages) {
  const dir = dirname(p.manifest_path);
  let files = licenseFiles(dir);
  let where = "";
  if (files.length === 0 && p.source.startsWith("git+")) {
    files = gitLicenseFiles(dir);
    where = "the repository's ";
  }
  const label = `${p.name} ${p.version}`;
  lines.push(`  ${label} — ${p.license ?? p.license_file ?? "no license declared"}${p.repository ? ` — ${p.repository}` : ""}`);
  if (files.length === 0) {
    keep(`(no license file in the published crate: ${p.license ?? "no license declared"} — its terms are those of that SPDX license)`, label);
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
    keep(text, `${label} (${where}${file.slice(file.lastIndexOf("/") + 1)})`);
  }
}

const table = readdirSync(data).find((name) => /^typeshed-stdlib-[0-9a-f]{40}\.tsv$/.test(name));
const commit = table.slice("typeshed-stdlib-".length, -".tsv".length);
const typeshed = readFileSync(join(data, "typeshed-LICENSE"), "utf8").replace(/\r\n/g, "\n").trim();
const out = [
  `Third-party software and data in codegraph-python ${root.version}`,
  "",
  `This binary is built from the ${packages.length} crates below, unmodified (build scripts and`,
  "macros among them), and embeds the data listed first.",
  "Where a crate's license expression names a license whose text the crate does not ship,",
  "its terms are those of that SPDX license.",
  "",
  "DATA",
  "",
  `  data/${table}:`,
  "  the names every module of the Python standard library binds, distilled from",
  `  typeshed's stdlib/ stubs at commit ${commit}`,
  "  (https://github.com/python/typeshed). typeshed is licensed under the Apache",
  "  License 2.0, parts of it under the MIT License; its LICENSE file is reproduced",
  "  in full at the end of this notice.",
  "  data/stdlib-py2.txt and data/builtins-py2.txt: lists of module and builtin",
  "  NAMES read from the Python 2.7 documentation's module index and library",
  "  reference (https://docs.python.org/2.7/); no text of the documentation is",
  "  reproduced.",
  "",
  `The ${packages.length} crates, with their declared licenses:`,
  ...lines,
  "",
  "Their license texts, each printed once, followed by the crates that ship it:",
];
for (const [text, owners] of byText) {
  out.push("", "=".repeat(78), ...owners.map((owner) => `  ${owner}`), "-".repeat(78), text);
}
out.push("", "=".repeat(78), `  typeshed ${commit} (LICENSE) — the standard-library table`, "-".repeat(78), typeshed);
process.stdout.write(`${out.join("\n")}\n`);
