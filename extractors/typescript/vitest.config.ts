import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests validate the extractor's output against core's SOURCE — the reference
 * reader and the TypeScript profile — so `pnpm --filter codegraph-typescript
 * test` needs no prior build. Core is a devDependency only: the extractor's
 * runtime depends on `typescript` and nothing else (boundary.test.ts).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@codegraph/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
});
