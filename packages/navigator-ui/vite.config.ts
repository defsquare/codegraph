import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import type { Connect } from "vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve the artifact named by the NAVIGATOR_JSON env var as `/navigator.json`
 * (and VOCABULARY_JSON's as `/vocabulary.json`), so the usual loop is one line:
 *
 *   NAVIGATOR_JSON=../../navigator.json pnpm --filter @codegraph/navigator-ui dev
 *
 * Without the env var the app falls back to `?src=URL`, drag & drop, or a file
 * picker — the dev server never becomes a required part of the pipeline.
 */
function artifactJsonPlugin(route: string, variable: string): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = process.env[variable];
    if (path === undefined || !(req.url ?? "").startsWith(route)) {
      next();
      return;
    }
    readFile(path)
      .then((buf) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", buf.byteLength);
        res.end(buf);
      })
      .catch((error: unknown) => {
        res.statusCode = 404;
        res.end(`${variable} not readable: ${String(error)}`);
      });
  };
  return {
    name: `codegraph-${route.slice(1)}`,
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
  // with a navigator.json placed beside index.html.
  base: "./",
  plugins: [
    react(),
    artifactJsonPlugin("/navigator.json", "NAVIGATOR_JSON"),
    artifactJsonPlugin("/vocabulary.json", "VOCABULARY_JSON"),
  ],
  build: { target: "es2023" },
});
