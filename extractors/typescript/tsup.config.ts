import { defineConfig } from "tsup";

/**
 * One bundle, `typescript` left OUTSIDE it (PLAN.md §14.1): the compiler
 * locates `lib.*.d.ts` relative to its own `typescript.js`, so a bundle that
 * inlined it would bind no standard library — every `Array` an `<unresolved>`
 * stub — while every test run from sources passed. The built-bin test pins it.
 */
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  external: ["typescript"],
  banner: { js: "#!/usr/bin/env node" },
});
