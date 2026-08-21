import { readFile } from "node:fs/promises";
import type { Connect } from "vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve the artifact named by the CITY_JSON env var as `/city.json`, so the
 * usual loop is one line:
 *
 *   CITY_JSON=../../city.json pnpm --filter @codegraph/viz dev
 *
 * Without the env var the app falls back to `?src=URL`, drag & drop, or a file
 * picker — the dev server never becomes a required part of the pipeline.
 */
function cityJsonPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = process.env["CITY_JSON"];
    if (path === undefined || !(req.url ?? "").startsWith("/city.json")) {
      next();
      return;
    }
    readFile(path)
      .then((buf) => {
        res.setHeader("content-type", "application/json");
        res.end(buf);
      })
      .catch((error: unknown) => {
        res.statusCode = 404;
        res.end(`CITY_JSON not readable: ${String(error)}`);
      });
  };
  return {
    name: "codegraph-city-json",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  // Relative base so `vite build` output runs from any static file server
  // (or file://) with a city.json placed beside index.html.
  base: "./",
  plugins: [cityJsonPlugin()],
  build: { target: "es2023" },
});
