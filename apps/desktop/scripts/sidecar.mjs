// Place the single-executable image where Tauri expects its sidecar
// (PLAN.md §15.4): `src-tauri/binaries/codegraph-<target triple>`, one file
// per triple, from what `./build.sh --ts --sea` wrote under
// `packages/cli/dist-sea/<rid>/`. The RID → triple table is the plan's.
//
//   node apps/desktop/scripts/sidecar.mjs [--rid RID]
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(DESKTOP, "..", "..");

export const TRIPLES = {
  "osx-arm64": "aarch64-apple-darwin",
  "osx-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win-x64": "x86_64-pc-windows-msvc",
};

export function hostRid(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "osx" : platform === "win32" ? "win" : "linux";
  return `${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

export function placeSidecar(rid = hostRid()) {
  const triple = TRIPLES[rid];
  if (triple === undefined) throw new Error(`no target triple for RID ${rid}`);
  const exe = rid.startsWith("win-") ? ".exe" : "";
  const source = join(ROOT, "packages", "cli", "dist-sea", rid, `codegraph${exe}`);
  if (!existsSync(source)) {
    throw new Error(`${source} is missing — run ./build.sh --ts --sea first`);
  }
  const target = join(DESKTOP, "src-tauri", "binaries", `codegraph-${triple}${exe}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--rid");
  try {
    const target = placeSidecar(index === -1 ? hostRid() : process.argv[index + 1]);
    process.stderr.write(`sidecar: ${target}\n`);
  } catch (error) {
    process.stderr.write(`sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
