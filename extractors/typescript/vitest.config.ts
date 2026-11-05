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
  // An extraction builds a TypeScript program: 0.2–0.5 s here, 2–5 s on a CI runner
  // under `pnpm -r test`, where the 5 s default timed out a test that extracts twice.
  test: { testTimeout: 30_000 },
});
