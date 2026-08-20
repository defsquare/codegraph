import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against the SOURCE of core and analyzer, so
 * `pnpm --filter @codegraph/cli test` needs no prior `pnpm -r build`. Real
 * consumers resolve both through their package `exports` maps to dist; CI's
 * `pnpm -r build` plus the built-binary check keep that path honest.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@codegraph/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@codegraph/analyzer": fileURLToPath(new URL("../analyzer/src/index.ts", import.meta.url)),
    },
  },
});
