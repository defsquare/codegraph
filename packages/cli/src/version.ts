import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seaAsset } from "./sea.js";

/**
 * `--version` reads the package's own `package.json` at runtime.
 *
 * NOT a JSON import assertion (`with { type: "json" }`): under NodeNext that
 * either fails to type-check or emits an import the bundler resolves at build
 * time, and the built `dist/index.js` then reports whatever version was compiled
 * in. Reading the file relative to `import.meta.url` works identically from
 * `src/` under Vitest and from `dist/index.js` as the installed bin — in both
 * cases `../package.json` is `packages/cli/package.json`.
 *
 * The single-executable image (PLAN §15.3) has no file beside itself, so it
 * carries `package.json` as an asset under that very key, and reads it first.
 */
const FALLBACK = "0.0.0-unknown";
let cached: string | undefined;

/** The version field of a package.json text, or the fallback for anything else. */
export function versionOf(text: string | undefined): string {
  if (text === undefined) return FALLBACK;
  try {
    const parsed: unknown = JSON.parse(text);
    const version =
      typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === "string" && version.length > 0 ? version : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function cliVersion(): string {
  if (cached !== undefined) return cached;
  const asset = seaAsset("package.json");
  if (asset !== undefined) {
    cached = versionOf(asset.toString("utf8"));
    return cached;
  }
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    cached = versionOf(readFileSync(path, "utf8"));
  } catch {
    // A missing package.json means a broken installation, not a reason to crash
    // a command that only wanted to print a string.
    cached = FALLBACK;
  }
  return cached;
}
