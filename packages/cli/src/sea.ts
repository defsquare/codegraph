import { Buffer } from "node:buffer";

/**
 * THE SINGLE-EXECUTABLE IMAGE (PLAN §15.3): the CLI bundled as CommonJS and
 * injected into a Node binary with the two frontends and `package.json` as
 * assets. Three facts differ from a checkout and this module owns all three,
 * so the rest of the CLI asks here instead of testing `import.meta.url`:
 *
 *   - whether this process IS the image (`node:sea`'s `isSea()`);
 *   - how to read an asset the image carries (a checkout has none);
 *   - what "node" is: `process.execPath` in a checkout is Node, in the image
 *     it is codegraph itself, so a `.js` extractor must run under the `node`
 *     on PATH — Homebrew's, in the desktop distribution.
 *
 * `node:sea` is reached through `process.getBuiltinModule`, not an import: a
 * bundler rewrites `import … from "node:sea"` into `require("sea")`, and the
 * prefix-only builtin does not answer to that name. Under Vitest and in the
 * ESM build every answer is the checkout's.
 */
interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

function seaModule(): SeaModule | undefined {
  try {
    return process.getBuiltinModule("node:sea") as SeaModule | undefined;
  } catch {
    return undefined;
  }
}

export function isSeaImage(): boolean {
  try {
    return seaModule()?.isSea() ?? false;
  } catch {
    return false;
  }
}

/** An asset by key, or undefined outside the image or for a key it does not carry. */
export function seaAsset(key: string): Buffer | undefined {
  const sea = seaModule();
  if (sea === undefined || !isSeaImage()) return undefined;
  try {
    return Buffer.from(sea.getAsset(key));
  } catch {
    return undefined;
  }
}

/** The command that runs a JavaScript file: this Node, unless this Node is codegraph. */
export function nodeCommand(): string {
  return isSeaImage() ? "node" : process.execPath;
}
