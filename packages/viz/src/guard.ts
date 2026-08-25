import type { CityLayout } from "@codegraph/city";

/**
 * `@codegraph/city`'s CITY_ARTEFACT_KIND, restated as a literal: the renderer
 * bundles for the browser, and a runtime import of the city package would drag
 * the whole Node-side pipeline (city -> analyzer -> core) into the bundle. A
 * test asserts this literal equals the real constant, so it cannot drift.
 */
export const CITY_ARTEFACT_KIND = "codegraph.city/1";

/**
 * The renderer's ONLY input is a laid-out city artifact — the JSON that
 * `codegraph city --layout` writes. This guard is the persistence boundary:
 * a `model.jsonl` (the interchange model, with the code details) or an
 * un-laid-out city is refused with the command that produces the right file,
 * never half-rendered.
 *
 * Structural checks only: the artifact is trusted to be internally consistent
 * (the city package's tests own that); what is verified here is that the file
 * IS that artifact and carries placement plus the conventions this renderer
 * implements.
 */
export class CityLoadError extends Error {
  override readonly name = "CityLoadError";
}

export function parseCityLayout(text: string): CityLayout {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CityLoadError(
      "Not JSON. The renderer reads the city artifact written by " +
        "'codegraph city <model.jsonl> --layout --out city.json' — " +
        "a model.jsonl itself is line-based and is not that artifact.",
    );
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CityLoadError("Not a city artifact: expected a JSON object.");
  }
  const city = data as Record<string, unknown>;

  if (city["kind"] !== CITY_ARTEFACT_KIND) {
    throw new CityLoadError(
      `Not a city artifact: kind is ${JSON.stringify(city["kind"])}, expected ` +
        `"${CITY_ARTEFACT_KIND}". Produce one with 'codegraph city <model.jsonl> --layout'.`,
    );
  }

  for (const key of ["districts", "buildings", "arrows", "bindings"]) {
    if (!Array.isArray(city[key])) {
      throw new CityLoadError(`Malformed city artifact: "${key}" is not an array.`);
    }
  }

  // An artifact from before module-level arrows simply has none to draw.
  if (!Array.isArray(city["districtArrows"])) {
    city["districtArrows"] = [];
  }

  // `replay` is optional (a static city has none), but when present it must
  // be usable — a half-shaped replay would render a scrubber that lies.
  const replay = city["replay"];
  if (replay !== undefined) {
    const block = replay as Record<string, unknown> | null;
    if (
      typeof block !== "object" ||
      block === null ||
      !Array.isArray(block["ticks"]) ||
      typeof block["series"] !== "object" ||
      block["series"] === null
    ) {
      throw new CityLoadError(
        "Malformed replay block: expected { ticks: [...], series: {...} }. " +
          "Produce one with 'codegraph history <history.jsonl> --serve'.",
      );
    }
  }

  // Placement is opt-in on the CLI; a city without it has sizes but no
  // coordinates, and inventing them here would be a second, undeclared layout.
  const laidOut =
    typeof city["layout"] === "object" &&
    city["layout"] !== null &&
    typeof city["bounds"] === "object" &&
    city["bounds"] !== null &&
    (city["buildings"] as unknown[]).every(
      (b) => typeof (b as Record<string, unknown>)["position"] === "object",
    ) &&
    (city["districts"] as unknown[]).every(
      (d) => typeof (d as Record<string, unknown>)["bounds"] === "object",
    );
  if (!laidOut) {
    throw new CityLoadError(
      "This city has no placement (no layout block / positions / bounds). " +
        "Re-run with the layout pass: 'codegraph city <model.jsonl> --layout'.",
    );
  }

  // The artifact states its conventions exactly once (CM-2); this renderer
  // implements y-up over an xz ground plane with roof-attached arrows, and
  // must refuse — not silently misdraw — an artifact declaring anything else.
  const conventions = city["conventions"] as Record<string, unknown> | undefined;
  if (
    conventions?.["heightAxis"] !== "y" ||
    conventions?.["groundPlane"] !== "xz" ||
    conventions?.["arrowAttachment"] !== "roof"
  ) {
    throw new CityLoadError(
      "This artifact declares conventions this renderer does not implement " +
        `(got ${JSON.stringify(conventions)}).`,
    );
  }

  return data as CityLayout;
}
