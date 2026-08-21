import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against core's and the analyzer's SOURCE, so this package's suite
 * needs no prior `pnpm -r build`. Consumers still resolve both through their
 * package `exports` maps; `pnpm -r build` in CI keeps that path honest.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@codegraph/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@codegraph/analyzer": fileURLToPath(new URL("../analyzer/src/index.ts", import.meta.url)),
    },
  },
});
