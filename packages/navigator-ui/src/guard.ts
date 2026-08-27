import type { NavigatorModel } from "@codegraph/navigator";

/**
 * The ONLY input this app accepts is a navigator artifact. The kind marker is
 * RESTATED here as a literal because a runtime import of `@codegraph/navigator`
 * would drag the whole Node-side pipeline (navigator → analyzer → core, zod and
 * the SQLite loader included) into the browser bundle; every import from that
 * package is `import type` only. `guard.test.ts` asserts the literal equals the
 * package's real constant, so the two cannot drift silently.
 */
export const NAVIGATOR_ARTEFACT_KIND = "codegraph.navigator/1";

export class NavigatorLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigatorLoadError";
  }
}

function fail(reason: string): never {
  throw new NavigatorLoadError(reason);
}

/**
 * Parse and check the artifact. Field-level validation stays structural (the
 * arrays exist and are arrays) — the artifact is produced by a builder whose
 * own test suite pins index closure, and re-validating half a million rows
 * here would double the very load time the progress bar exists to excuse.
 */
export function parseNavigatorModel(text: string): NavigatorModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("this file is not JSON. Produce one with 'codegraph navigator model.jsonl --out navigator.json'.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("this JSON is not a navigator artifact (not an object).");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate["kind"] !== NAVIGATOR_ARTEFACT_KIND) {
    fail(
      `this JSON is not a navigator artifact (kind ${JSON.stringify(candidate["kind"] ?? "missing")}, ` +
        `expected "${NAVIGATOR_ARTEFACT_KIND}"). A model.jsonl itself is not one — ` +
        `run 'codegraph navigator' over it first.`,
    );
  }
  for (const key of ["files", "nodes", "roots", "deps"]) {
    if (!Array.isArray(candidate[key])) fail(`this navigator artifact is missing its '${key}' array.`);
  }
  return parsed as NavigatorModel;
}
