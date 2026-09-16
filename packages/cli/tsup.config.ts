import { defineConfig } from "tsup";

/**
 * Two builds of one CLI:
 *
 *   dist/index.js       ESM, the workspace packages external — what `pnpm`
 *                       users, `bin/codegraph` and the tests' e2e harness run.
 *   dist-sea/codegraph.cjs
 *                       CommonJS, ONE file, everything inlined but Node's
 *                       built-ins — the main script of the single-executable
 *                       image (PLAN §15.3). `splitting: false` folds the
 *                       lazily imported `explain` chunk back in (a SEA's
 *                       `require` reaches built-ins only); `shims` gives the
 *                       few `import.meta.url` readers a `__filename`-based
 *                       stand-in. No shebang: the file is never executed as a
 *                       script, only read into the blob.
 */
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { codegraph: "src/sea-entry.ts" },
    outDir: "dist-sea",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    splitting: false,
    dts: false,
    sourcemap: false,
    // Never clean: dist-sea/<rid>/codegraph, the injected image, lives beside
    // the bundle and must survive a `pnpm -r build`; the bundle is overwritten.
    clean: false,
    shims: true,
    noExternal: [/.*/],
  },
]);
