// The single-executable image's `sea-config.json` (PLAN §15.3), GENERATED:
// Node's SEA assets are a flat map of key → file, so every file of the two
// frontend bundles has to be listed one by one, and a list written by hand
// goes stale the first time Vite renames a hashed chunk. Keys are
// `viz/<relative>` and `navigator-ui/<relative>` — exactly what
// `seaFrontendAssets(prefix)` in src/assets.ts reads — plus `package.json`
// for `--version`. Paths are absolute, so where `node --experimental-sea-config`
// is run from does not matter.
//
//   node packages/cli/scripts/sea-config.mjs [--out FILE]
//
// Exported for the test; the CLI form writes the file.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = resolve(CLI_DIR, "..");

/** The node:sea sentinel fuse — Node's own constant, needed by postject. */
export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Every regular file below `root`, as forward-slash relative paths, sorted. */
export function filesBelow(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The config object. `frontends` maps an asset prefix to a built dist
 * directory; `main` is the CJS bundle, `output` where the blob goes.
 */
export function seaConfig({ main, output, packageJson, frontends }) {
  const assets = { "package.json": resolve(packageJson) };
  for (const [prefix, dir] of Object.entries(frontends).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const file of filesBelow(dir)) assets[`${prefix}/${file}`] = resolve(dir, file);
  }
  return {
    main: resolve(main),
    output: resolve(output),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets,
  };
}

/** The repository's own layout: the CLI bundle and the two frontends. */
export function repositorySeaConfig(outDir = join(CLI_DIR, "dist-sea")) {
  return seaConfig({
    main: join(outDir, "codegraph.cjs"),
    output: join(outDir, "codegraph.blob"),
    packageJson: join(CLI_DIR, "package.json"),
    frontends: {
      viz: join(PACKAGES_DIR, "viz", "dist"),
      "navigator-ui": join(PACKAGES_DIR, "navigator-ui", "dist"),
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex === -1 ? join(CLI_DIR, "dist-sea", "sea-config.json") : resolve(process.argv[outIndex + 1]);
  const config = repositorySeaConfig(dirname(out));
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
  process.stderr.write(`sea-config: ${Object.keys(config.assets).length} assets → ${out}\n`);
}
