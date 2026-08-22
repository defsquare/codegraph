import type { CityLayout } from "@codegraph/city";
import { legendModel, type LegendEntry } from "./legend.js";

/**
 * The help dialog's content, as a MODEL: fixed concept text plus the
 * artifact-derived legend, so what the popup claims about the encodings is
 * exactly what the legend (and therefore the artifact) declares — unit-tested,
 * never free-hand DOM prose that could drift from the render.
 */
export interface HelpSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface HelpModel {
  readonly sections: readonly HelpSection[];
  /** Empty until a city is loaded — the legend belongs to an artifact. */
  readonly legend: readonly LegendEntry[];
}

/** Where the shell remembers that the help was shown once. */
export const HELP_SEEN_KEY = "codegraph.help.seen";

export function helpModel(city: CityLayout | null): HelpModel {
  const sections: HelpSection[] = [
    {
      heading: "The city",
      paragraphs: [
        "This is your code as a city: every district is a module (a package), " +
          "every building is a type declared there. Building dimensions follow " +
          "the metrics named in the legend below — a taller tower holds more " +
          "code; nothing is decorative.",
        "A washed-out building is a stub: an external type the model only " +
          "glimpsed through its uses. Nested plates are nested modules, " +
          "exactly as the model declares them.",
      ],
    },
    {
      heading: "Dependencies",
      paragraphs: [
        "Dependency arrows rest hidden until you ask for them: click a " +
          "building or a district to see exactly its fan-in (who depends on " +
          "it) and fan-out (what it depends on), direction by hue.",
        "'Show all dependencies' draws the whole overview instead. Everywhere, " +
          "saturation carries provenance: a declared fact keeps its full hue, " +
          "an inferred dependency (any non-declared base edge) is desaturated " +
          "— the picture never presents an inference as a fact.",
      ],
    },
    {
      heading: "Reading the city",
      paragraphs: [
        "Hover names an element; click it for details — a district's contents " +
          "and coupling, a building's metrics, attributes and operations. " +
          "Click again (or click the ground) to deselect.",
        "Drop another city.json anywhere to load it. '?landscape=1' starts " +
          "with buildings hidden — the pure module landscape.",
      ],
    },
  ];
  return { sections, legend: city === null ? [] : legendModel(city) };
}
