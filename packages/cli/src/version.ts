import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `--version` reads the package's own `package.json` at runtime.
 *
 * NOT a JSON import assertion (`with { type: "json" }`): under NodeNext that
 * either fails to type-check or emits an import the bundler resolves at build
 * time, and the built `dist/index.js` then reports whatever version was compiled
 * in. Reading the file relative to `import.meta.url` works identically from
 * `src/` under Vitest and from `dist/index.js` as the installed bin — in both
 * cases `../package.json` is `packages/cli/package.json`.
 */
const FALLBACK = "0.0.0-unknown";
let cached: string | undefined;

export function cliVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    cached = typeof version === "string" && version.length > 0 ? version : FALLBACK;
  } catch {
    // A missing package.json means a broken installation, not a reason to crash
    // a command that only wanted to print a string.
    cached = FALLBACK;
  }
  return cached;
}
