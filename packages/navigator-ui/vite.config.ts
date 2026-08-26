import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import type { Connect } from "vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve the artifact named by the NAVIGATOR_JSON env var as `/navigator.json`,
 * so the usual loop is one line:
 *
 *   NAVIGATOR_JSON=../../navigator.json pnpm --filter @codegraph/navigator-ui dev
 *
 * Without the env var the app falls back to `?src=URL`, drag & drop, or a file
 * picker — the dev server never becomes a required part of the pipeline.
 */
function navigatorJsonPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = process.env["NAVIGATOR_JSON"];
    if (path === undefined || !(req.url ?? "").startsWith("/navigator.json")) {
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
        res.end(`NAVIGATOR_JSON not readable: ${String(error)}`);
      });
  };
  return {
    name: "codegraph-navigator-json",
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
  plugins: [react(), navigatorJsonPlugin()],
  build: { target: "es2023" },
});
