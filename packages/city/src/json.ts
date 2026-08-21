import type { CityModel } from "./city.js";

/**
 * The city as JSON, deterministically.
 *
 * A CITY IS NOT A MODEL.JSONL. It carries `kind: "codegraph.city/1"` and
 * `generatedBy`, and deliberately no `schemaVersion` — that key is the
 * interchange format's marker, and a file carrying one claims to be extractor
 * output. This is derived from such a file and is never read back as one.
 *
 * `JSON.stringify` preserves insertion order and every array the builder
 * produces is already sorted, so two runs over the same model and options are
 * byte-identical without a sort pass here.
 */
export function cityToJsonString(city: CityModel, options?: { readonly pretty?: boolean }): string {
  return options?.pretty === false ? JSON.stringify(city) : `${JSON.stringify(city, null, 2)}\n`;
}
