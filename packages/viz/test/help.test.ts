import { describe, expect, it } from "vitest";
import { HELP_SEEN_KEY, helpModel } from "../src/scene/help.js";
import { makeCity } from "./fixture.js";

/**
 * The help dialog's content is a MODEL, so what the popup claims about the
 * encodings is asserted here against the artifact's own declarations — the
 * text cannot drift from what is actually drawn.
 */
describe("helpModel", () => {
  it("explains the concept and the capabilities", () => {
    const help = helpModel(makeCity());
    const headings = help.sections.map((section) => section.heading);
    expect(headings).toContain("The city");
    expect(headings).toContain("Dependencies");
    expect(headings).toContain("Reading the city");
    const text = help.sections.flatMap((section) => section.paragraphs).join(" ");
    expect(text).toContain("district");
    expect(text).toContain("building");
    expect(text).toContain("click");
  });

  it("states that edges rest hidden and appear on selection", () => {
    const text = helpModel(makeCity())
      .sections.flatMap((section) => section.paragraphs)
      .join(" ");
    expect(text.toLowerCase()).toContain("hidden until");
  });

  it("embeds the artifact-derived legend when a city is loaded", () => {
    const help = helpModel(makeCity());
    expect(help.legend.some((entry) => entry.label === "height = loc (linear)")).toBe(true);
    expect(help.legend.some((entry) => entry.swatch === "fanIn")).toBe(true);
  });

  it("has no legend before a city is loaded", () => {
    expect(helpModel(null).legend).toEqual([]);
    expect(helpModel(null).sections.length).toBeGreaterThan(0);
  });

  it("pins the localStorage key the shell persists 'seen' under", () => {
    expect(HELP_SEEN_KEY).toBe("codegraph.help.seen");
  });
});
