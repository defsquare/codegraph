import { defineConfig } from "tsup";

export default defineConfig({
  // `cloud` is its own entry: a page imports the layout without the pipeline behind `index`.
  entry: ["src/index.ts", "src/cloud.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
