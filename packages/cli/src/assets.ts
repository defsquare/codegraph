import type { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { seaAsset } from "./sea.js";

/**
 * WHERE A FRONTEND'S FILES COME FROM — one interface, two sources.
 *
 * In a checkout the prebuilt Vite bundle is a directory (`packages/viz/dist`,
 * `packages/navigator-ui/dist`); in the single-executable image (PLAN §15.3)
 * the same files are assets keyed `viz/<relative>` and
 * `navigator-ui/<relative>`. The servers ask an `FrontendAssets` for a
 * relative path and get bytes or nothing; neither knows which source
 * answered, so one test suite covers both through the same server.
 */
export interface FrontendAssets {
  /** For messages: the directory, or `sea:<prefix>`. */
  readonly label: string;
  /** The file at a forward-slash relative path below the bundle root, or undefined. */
  read(relative: string): Buffer | undefined;
}

/**
 * A directory, JAILED: the resolved path must stay under the root, so a
 * traversal (`..%2F..%2Fetc%2Fpasswd`) reads nothing instead of a file.
 */
export function directoryAssets(root: string): FrontendAssets {
  const base = resolve(root);
  return {
    label: base,
    read(relative) {
      const file = resolve(base, relative);
      if (file !== base && !file.startsWith(base + sep)) return undefined;
      try {
        return readFileSync(file);
      } catch {
        return undefined;
      }
    },
  };
}

/** Assets behind a key lookup — the image's `getAsset`, or a map in a test. */
export function keyedAssets(
  label: string,
  prefix: string,
  lookup: (key: string) => Buffer | undefined,
): FrontendAssets {
  return {
    label,
    read(relative) {
      // Keys are flat strings the build wrote from a directory walk: forward
      // slashes, no `.` or `..` segments — so a normalized path with either
      // cannot name one, and the jail is the key space itself.
      if (relative.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
      return lookup(`${prefix}/${relative}`);
    },
  };
}

/** The image's copy of a frontend bundle, keys `<prefix>/<relative>` (scripts/sea-config.mjs writes them). */
export function seaFrontendAssets(prefix: string): FrontendAssets {
  return keyedAssets(`sea:${prefix}`, prefix, seaAsset);
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The route below a mount point as the bundle's relative path; `/` is the index. */
export function relativeOfRoute(route: string): string {
  const relative = normalize(route).replace(/^[/\\]+/, "").split(sep).join("/");
  return relative === "" || relative === "." ? "index.html" : relative;
}

/**
 * Answer a static request from the bundle: bytes with the extension's MIME
 * type, or 404 — for a missing file and for a traversal alike, since the
 * source cannot tell them apart and should not try.
 */
export function serveStatic(assets: FrontendAssets, route: string, method: string, response: ServerResponse): void {
  const relative = relativeOfRoute(route);
  const body = assets.read(relative);
  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(relative)] ?? "application/octet-stream" });
  response.end(method === "HEAD" ? undefined : body);
}
