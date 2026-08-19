import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against core's SOURCE, so `pnpm --filter @codegraph/analyzer test`
 * needs no prior `pnpm -r build`. Real consumers still resolve `@codegraph/core`
 * to its dist through the package `exports` map; `pnpm -r build` in CI keeps
 * that path honest.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@codegraph/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
