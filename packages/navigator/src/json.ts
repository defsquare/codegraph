import type { NavigatorModel } from "./model.js";

/**
 * The navigator model as JSON, deterministically. Like the city artefact it
 * carries `kind` and `generatedBy` and deliberately NO `schemaVersion` — that
 * key is the interchange format's marker. Every array the builder produces is
 * already sorted, so `JSON.stringify` insertion order suffices for two runs to
 * be byte-identical.
 *
 * Default is COMPACT, unlike the city: this artefact scales with the base edge
 * count (a real corpus is hundreds of thousands of rows) and its consumer is a
 * parser behind a progress bar, not a human eye.
 */
export function navigatorToJsonString(
  model: NavigatorModel,
  options?: { readonly pretty?: boolean },
): string {
  return options?.pretty === true ? `${JSON.stringify(model, null, 2)}\n` : JSON.stringify(model);
}
