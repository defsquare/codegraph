import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE PAGE IS NOT THE SHELL (PLAN §15). The desktop app's page is this bundle
 * served by the daemon on loopback, same origin as its artifacts; it talks to
 * the daemon over plain HTTP and SSE and never over Tauri IPC. So no package
 * under `packages/` may import `@tauri-apps/*` — the only place that ever will
 * is `apps/desktop`, the shell, and that is a Rust crate with a one-line
 * starting page. Keeping this true is what keeps CORS between the webview
 * origin and loopback from ever arising, and this frontend runnable in any
 * browser as the development loop.
 */
const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
// The QUOTED form — an import specifier or a package.json dependency key —
// so a comment that names the rule (like this one) does not count as a use.
const TAURI = '"@tauri' + "-apps/";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|json)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("the Tauri boundary", () => {
  it("no package imports or depends on @tauri-apps/*", () => {
    const users = sourceFiles(PACKAGES)
      .filter((path) => readFileSync(path, "utf8").includes(TAURI))
      .map((path) => relative(PACKAGES, path))
      .sort();
    expect(users).toEqual([]);
  });
});
