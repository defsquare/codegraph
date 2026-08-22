import type { CityLayout } from "@codegraph/city";

/**
 * The on-screen legend, derived from the artifact's own declarations — its
 * `bindings` (the machine-form legend CM-3 ships) plus the fixed semantic
 * colors. Nothing here is invented by the renderer, so the legend cannot
 * drift from what was actually measured and drawn.
 */
export interface LegendEntry {
  /** Which swatch to draw beside the label; null = text-only line. */
  readonly swatch: "building" | "stub" | "declared" | "inferred" | "fanIn" | "fanOut" | null;
  readonly label: string;
  readonly detail: string | undefined;
}

export function legendModel(city: CityLayout): readonly LegendEntry[] {
  const entries: LegendEntry[] = [];

  entries.push({
    swatch: null,
    label: `view ${city.view.name}`,
    detail:
      `${city.districts.length} districts, ${city.buildings.length} buildings, ` +
      `${city.arrows.length} arrows`,
  });

  for (const binding of city.bindings) {
    const unmeasured =
      binding.unmeasured > 0
        ? ` — ${binding.unmeasured} unmeasured, drawn at the minimum`
        : "";
    entries.push({
      swatch: null,
      label: `${binding.channel} = ${binding.metric} (${binding.scale})`,
      detail: `${binding.describe}${unmeasured}`,
    });
  }

  entries.push(
    { swatch: "building", label: "building", detail: "a type declared in the corpus" },
    { swatch: "stub", label: "stub", detail: "an external type the model only glimpsed" },
    { swatch: "declared", label: "declared", detail: "every base edge is a declared fact" },
    {
      swatch: "inferred",
      label: "inferred",
      detail: "at least one base edge is derived, dynamic-candidate or generated",
    },
    {
      swatch: "fanIn",
      label: "fan-in",
      detail: "arrows into the selected element — who depends on it",
    },
    {
      swatch: "fanOut",
      label: "fan-out",
      detail: "arrows out of the selected element — what it depends on (inferred = desaturated)",
    },
  );

  entries.push({
    swatch: null,
    label: `layout ${city.layout.algorithm}`,
    detail:
      `gaps ${city.layout.buildingGap}/${city.layout.districtPadding}/` +
      `${city.layout.districtGap} (street/sidewalk/avenue)`,
  });

  return entries;
}
