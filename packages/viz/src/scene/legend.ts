import type { CityLayout, ReplayCityLayout } from "@codegraph/city";

/**
 * The on-screen legend, derived from the artifact's own declarations — its
 * `bindings` (the machine-form legend CM-3 ships) plus the fixed semantic
 * colors. Nothing here is invented by the renderer, so the legend cannot
 * drift from what was actually measured and drawn.
 */
export interface LegendEntry {
  /** Which swatch to draw beside the label; null = text-only line. */
  readonly swatch: "building" | "stub" | "fanIn" | "fanOut" | "heat" | "age" | "coChange" | null;
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
    {
      swatch: "fanIn",
      label: "fan-in",
      detail:
        "arrows into the selected element — who depends on it; those neighbors tint this hue",
    },
    {
      swatch: "fanOut",
      label: "fan-out",
      detail:
        "arrows out of the selected element — what it depends on; those neighbors tint " +
        "this hue (inferred = desaturated)",
    },
    {
      swatch: null,
      label: "selection",
      detail: "the clicked building or district turns violet; each arc's far end tints by direction",
    },
  );

  // The TIME COLORS exist only where a time axis does — a replay artifact.
  const replay = (city as Partial<ReplayCityLayout>).replay;
  if (replay !== undefined) {
    entries.push(
      {
        swatch: "heat",
        label: "heat",
        detail:
          "changed at the scrubbed tick — ember, cooling over the following ticks " +
          "('Colors: Time')",
      },
      {
        swatch: "age",
        label: "age",
        detail: "ticks lived since birth — old code desaturates toward gray, never disappears",
      },
    );
    if (city.buildings.some((building) => building.owner !== undefined)) {
      entries.push({
        swatch: null,
        label: "owner",
        detail:
          "'Colors: Owner' paints each building by its file's dominant author " +
          "(mined from history); neutral gray = no owner recorded",
      });
    }
    if (replay.coChange !== undefined && replay.coChange.length > 0) {
      entries.push({
        swatch: "coChange",
        label: "co-change",
        detail:
          "dashed — changes together in history (logical coupling): an inference, " +
          "never a dependency; shows for the selected building",
      });
    }
  }

  entries.push({
    swatch: null,
    label: `layout ${city.layout.algorithm}`,
    detail:
      `gaps ${city.layout.buildingGap}/${city.layout.districtPadding}/` +
      `${city.layout.districtGap} (street/sidewalk/avenue)`,
  });

  return entries;
}
