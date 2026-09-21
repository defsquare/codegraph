// Build the single-executable image (PLAN §15.3) for THIS platform:
//
//   1. tsup has written dist-sea/codegraph.cjs (pnpm --filter @codegraph/cli build);
//   2. write sea-config.json listing the bundle and every frontend asset;
//   3. node --experimental-sea-config → dist-sea/codegraph.blob;
//   4. copy the running Node binary to dist-sea/<rid>/codegraph[.exe];
//   5. macOS: strip Node's signature (postject would break it anyway);
//   6. inject the blob under the NODE_SEA_BLOB resource with the sentinel fuse;
//   7. macOS: sign ad hoc — arm64 refuses to run an unsigned Mach-O at all.
//      The Developer ID signature comes with the bundle (§15.5).
//
// No cross-compilation: the image is the Node that builds it, so CI runs this
// once per runner (the `sea` matrix), exactly like the Java native job.
//
//   node packages/cli/scripts/sea-build.mjs [--rid RID] [--out DIR]
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_DIR, repositorySeaConfig, SEA_FUSE } from "./sea-config.mjs";

const require = createRequire(import.meta.url);

/** The RID vocabulary the other binaries use: extractors/java/dist/<rid>/ and the C# matrix. */
export function hostRid(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "osx" : platform === "win32" ? "win" : "linux";
  return `${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

/** Why this Node cannot build an image, or undefined. Homebrew compiles node without SEA. */
export function seaUnsupported(variables = process.config.variables, execPath = process.execPath) {
  if (variables.single_executable_application !== false) return undefined;
  return (
    `${execPath} was compiled without single-executable support (Homebrew's node is) — ` +
    "install an official Node from https://nodejs.org/download/release/ and point CODEGRAPH_SEA_NODE at its binary"
  );
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${command} ${args.join(" ")} exited ${result.status ?? result.signal})`);
  }
}

function say(text) {
  process.stderr.write(`sea-build: ${text}\n`);
}

export async function buildSea({ rid = hostRid(), outDir = join(CLI_DIR, "dist-sea") } = {}) {
  const unsupported = seaUnsupported();
  if (unsupported) throw new Error(unsupported);
  const bundle = join(outDir, "codegraph.cjs");
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} is missing — run 'pnpm --filter @codegraph/cli build' first`);
  }
  const config = repositorySeaConfig(outDir);
  for (const [key, path] of Object.entries(config.assets)) {
    if (!existsSync(path)) {
      throw new Error(`asset ${key} → ${path} is missing — run 'pnpm -r build' so both frontends exist`);
    }
  }
  const configPath = join(outDir, "sea-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  say(`${Object.keys(config.assets).length} assets listed in ${configPath}`);

  run(process.execPath, ["--experimental-sea-config", configPath], "the SEA blob");
  const blobSize = statSync(config.output).size;
  say(`blob ${(blobSize / 1e6).toFixed(1)} MB`);

  const exe = process.platform === "win32" ? "codegraph.exe" : "codegraph";
  const target = join(outDir, rid, exe);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  say(`copied ${process.execPath} (${process.version}) → ${target}`);

  if (process.platform === "darwin") run("codesign", ["--remove-signature", target], "removing Node's signature");

  const { inject } = require("postject");
  const { readFileSync } = await import("node:fs");
  await inject(target, "NODE_SEA_BLOB", readFileSync(config.output), {
    sentinelFuse: SEA_FUSE,
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  say(`injected the blob into ${target}`);

  if (process.platform === "darwin") run("codesign", ["--sign", "-", target], "ad-hoc signing");

  say(`image ${(statSync(target).size / 1e6).toFixed(0)} MB at ${target}`);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (flag) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const out = arg("--out");
  buildSea({ ...(arg("--rid") ? { rid: arg("--rid") } : {}), ...(out ? { outDir: resolve(out) } : {}) }).catch(
    (error) => {
      process.stderr.write(`sea-build: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
