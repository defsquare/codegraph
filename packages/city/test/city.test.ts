import { renderId, type Entity } from "@codegraph/core";
import { internalOnly } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { buildCity, CITY_ARTEFACT_KIND } from "../src/city.js";
import { edge, field, graphOf, graphOfModels, javaGraph, method, pkg, stubType, type } from "./fixture.js";

/**
 * The city is a SECOND MODEL, so what these tests guard is the mapping, not a
 * picture: which model concept became which city concept, that every dimension
 * names the metric behind it, and that "unmeasured" never arrives disguised as
 * "smallest". Placement is deliberately absent and stays that way until the
 * layout pass lands.
 */

/** Two packages, three types of different sizes, one dependency between them. */
function toyGraph() {
  return graphOf(
    [
      pkg("java:a"),
      pkg("java:b"),
      type("java:a/Small", "java:a", 10),
      type("java:a/Big", "java:a", 110, { cyclomatic: 3 }),
      type("java:b/Other", "java:b", 60),
      method("java:a/Big.run()", "java:a/Big", { cyclomatic: 7 }),
      method("java:a/Big.stop()", "java:a/Big", { cyclomatic: 5 }),
      field("java:a/Big.state", "java:a/Big"),
    ],
    [
      edge("invocation", "java:a/Big.run()", "java:b/Other"),
      edge("reference", "java:a/Small", "java:a/Big", "derived"),
    ],
  );
}

describe("buildCity: the mapping", () => {
  it("turns modules into districts and types into buildings", () => {
    const city = buildCity(toyGraph());
    expect(city.kind).toBe(CITY_ARTEFACT_KIND);
    expect(city.districts.map((district) => district.id)).toEqual(["java:a", "java:b"]);
    expect(city.buildings.map((building) => building.id)).toEqual([
      "java:a/Big",
      "java:a/Small",
      "java:b/Other",
    ]);
    // A building stands in exactly one district, and the district lists it back.
    for (const building of city.buildings) {
      const district = city.districts.find((candidate) => candidate.id === building.district);
      expect(district?.buildings).toContain(building.id);
    }
  });

  it("draws a roof-to-roof arrow per type dependency, weighted and provenance-aware", () => {
    const city = buildCity(toyGraph());
    expect(city.conventions.arrowAttachment).toBe("roof");
    const arrows = city.arrows.map((arrow) => [arrow.from, arrow.to, arrow.inferred]);
    expect(arrows).toEqual([
      ["java:a/Big", "java:b/Other", false],
      ["java:a/Small", "java:a/Big", true],
    ]);
    expect(city.arrows[0]?.count).toBe(1);
    expect(city.arrows[0]?.crossDistrict).toBe(true);
    expect(city.arrows[1]?.crossDistrict).toBe(false);
  });

  it("does not place anything: layout is a later pass", () => {
    const city = buildCity(toyGraph());
    for (const building of city.buildings) {
      expect(building).not.toHaveProperty("position");
    }
    for (const district of city.districts) {
      expect(district).not.toHaveProperty("bounds");
      // What the layout pass gets instead: the area its buildings need.
      const own = city.buildings.filter((building) => building.district === district.id);
      const demand = own.reduce(
        (total, building) => total + building.footprint.width * building.footprint.depth,
        0,
      );
      expect(district.footprintDemand).toBeCloseTo(demand, 3);
    }
  });

  it("excludes a type whose module the model does not give, and says so", () => {
    // A type with no parent has no module to stand in; inventing one would put
    // a building on ground the model never described.
    const graph = graphOf([
      pkg("java:a"),
      type("java:a/Placed", "java:a", 10),
      {
        id: "java:Floating",
        kind: "class",
        traits: ["TNamed", "TType"],
        name: "Floating",
        isStub: false,
      },
    ] as never);
    const city = buildCity(graph);
    expect(city.buildings.map((building) => building.id)).toEqual(["java:a/Placed"]);
    expect(city.diagnostics.unplacedBuildings).toEqual(["java:Floating"]);
  });

  it("nests a district under the nearest ANCESTOR district the model declares", () => {
    const graph = graphOf(
      [
        pkg("java:a"),
        pkg("java:a.sub", false, "java:a"),
        // An intermediate module the view keeps but nobody builds in — it is
        // no district, so its child must chain PAST it to java:a.
        pkg("java:a.empty", false, "java:a"),
        pkg("java:a.empty.deep", false, "java:a.empty"),
        type("java:a/Top", "java:a", 10),
        type("java:a.sub/Nested", "java:a.sub", 10),
        type("java:a.empty.deep/Deep", "java:a.empty.deep", 10),
      ],
      [],
    );
    const city = buildCity(graph);
    const parents = new Map(city.districts.map((d) => [d.id, d.parent] as const));
    expect(parents.get("java:a")).toBeUndefined();
    expect(parents.get("java:a.sub")).toBe("java:a");
    expect(parents.get("java:a.empty.deep")).toBe("java:a");
    // The empty intermediate module produced no district at all.
    expect(city.districts.map((d) => d.id)).not.toContain("java:a.empty");
  });

  it("ships module-level dependencies as districtArrows, never re-derived downstream", () => {
    const city = buildCity(toyGraph());
    expect(city.districtArrows.map((a) => [a.from, a.to, a.count])).toEqual([
      ["java:a", "java:b", 1],
    ]);
    // The a->a type dependency folded into module cohesion, not an arrow.
    expect(city.diagnostics.selfDistrictArrows).toBeGreaterThanOrEqual(1);
    expect(city.districtArrows[0]?.crossDistrict).toBe(true);
  });

  it("drops a type-level self-dependency instead of drawing an arrow to one roof", () => {
    const graph = graphOf(
      [
        pkg("java:a"),
        type("java:a/T", "java:a", 20),
        method("java:a/T.one()", "java:a/T"),
        method("java:a/T.two()", "java:a/T"),
      ],
      [edge("invocation", "java:a/T.one()", "java:a/T.two()")],
    );
    const city = buildCity(graph);
    expect(city.arrows).toEqual([]);
    expect(city.diagnostics.selfArrows).toBe(1);
  });
});

describe("buildCity: dimensions state what produced them", () => {
  it("binds height to lines of code and footprint to members by default", () => {
    const city = buildCity(toyGraph());
    const height = city.bindings.find((binding) => binding.channel === "height");
    const footprint = city.bindings.find((binding) => binding.channel === "footprint");
    expect(height?.metric).toBe("loc");
    expect(height?.scale).toBe("linear");
    expect(height?.unit).toBe("source lines");
    expect(footprint?.metric).toBe("members");
    // Footprint scales the metric onto the SIDE through sqrt, so base area
    // grows linearly with the metric.
    expect(footprint?.scale).toBe("sqrt");
  });

  it("makes the biggest measured building the tallest and the smallest the shortest", () => {
    const city = buildCity(toyGraph());
    const height = (id: string): number =>
      city.buildings.find((building) => building.id === id)?.height ?? Number.NaN;
    expect(height("java:a/Big")).toBeGreaterThan(height("java:b/Other"));
    expect(height("java:b/Other")).toBeGreaterThan(height("java:a/Small"));
    const binding = city.bindings.find((b) => b.channel === "height");
    expect(binding?.domain).toEqual({ min: 10, max: 110 });
    expect(height("java:a/Big")).toBe(binding?.range.max);
    expect(height("java:a/Small")).toBe(binding?.range.min);
  });

  it("carries the raw measurement next to the dimension it produced", () => {
    const city = buildCity(toyGraph(), { carry: ["methods", "fields"] });
    const big = city.buildings.find((building) => building.id === "java:a/Big");
    expect(big?.metrics["loc"]).toBe(110);
    expect(big?.metrics["methods"]).toBe(2);
    expect(big?.metrics["fields"]).toBe(1);
  });

  it("renders an all-equal city as uniform, not as uniformly minimal", () => {
    const graph = graphOf([
      pkg("java:a"),
      type("java:a/One", "java:a", 30),
      type("java:a/Two", "java:a", 30),
    ]);
    const city = buildCity(graph);
    const heights = city.buildings.map((building) => building.height);
    expect(new Set(heights).size).toBe(1);
    const binding = city.bindings.find((b) => b.channel === "height");
    expect(heights[0]).toBeGreaterThan(binding?.range.min ?? 0);
  });

  it("is configurable: any metric can drive any channel, on any scale", () => {
    const city = buildCity(toyGraph(), {
      height: { metric: "methods", scale: "linear", min: 5, max: 15 },
      footprint: { metric: "one", min: 4, max: 4 },
    });
    expect(city.bindings.find((b) => b.channel === "height")?.metric).toBe("methods");
    const big = city.buildings.find((building) => building.id === "java:a/Big");
    const small = city.buildings.find((building) => building.id === "java:a/Small");
    expect(big?.height).toBe(15);
    expect(small?.height).toBe(5);
    // A constant metric leaves every footprint identical.
    expect(new Set(city.buildings.map((b) => b.footprint.width))).toEqual(new Set([4]));
  });

  it("reads an extractor-supplied measurement, summed over the type's members", () => {
    // No extractor emits cyclomatic complexity yet; entities are loose objects,
    // so the day one does, `sum:cyclomatic` is a height without a code change.
    const city = buildCity(toyGraph(), { height: { metric: "sum:cyclomatic" } });
    const metrics = (id: string): number | null | undefined =>
      city.buildings.find((building) => building.id === id)?.metrics["sum:cyclomatic"];
    // 3 on the type + 7 + 5 on its methods.
    expect(metrics("java:a/Big")).toBe(15);
    // Nothing under Small carries the key: unmeasured, NOT zero.
    expect(metrics("java:a/Small")).toBeNull();
    expect(city.bindings.find((b) => b.channel === "height")?.unmeasured).toBe(2);
  });

  it("floors an unmeasured building and counts it rather than calling it zero", () => {
    const graph = graphOf([
      pkg("java:a"),
      type("java:a/Measured", "java:a", 40),
      // A stub type has no anchor: the model does not say how long it is.
      stubType("java:a/External", "java:a"),
    ]);
    const city = buildCity(graph);
    const external = city.buildings.find((building) => building.id === "java:a/External");
    const binding = city.bindings.find((b) => b.channel === "height");
    expect(external?.metrics["loc"]).toBeNull();
    expect(external?.height).toBe(binding?.range.min);
    expect(binding?.unmeasured).toBe(1);
    expect(city.diagnostics.unmeasured["loc"]).toBe(1);
  });

  it("rejects an unknown metric instead of quietly falling back", () => {
    expect(() => buildCity(toyGraph(), { height: { metric: "nonsense" } })).toThrow(
      /unknown metric source/,
    );
    expect(() => buildCity(toyGraph(), { height: { scale: "quadratic" } })).toThrow(/unknown scale/);
  });
});

describe("buildCity: views and determinism", () => {
  it("carries the view it was built under", () => {
    const city = buildCity(toyGraph(), { view: internalOnly });
    expect(city.view.name).toBe("internalOnly");
  });

  it("drops external buildings under internalOnly", () => {
    const graph = graphOf([
      pkg("java:a"),
      type("java:a/Mine", "java:a", 20),
      stubType("java:a/Theirs", "java:a"),
    ]);
    expect(buildCity(graph).buildings).toHaveLength(2);
    const internal = buildCity(graph, { view: internalOnly });
    expect(internal.buildings.map((building) => building.id)).toEqual(["java:a/Mine"]);
  });

  it("is byte-identical across runs", () => {
    expect(JSON.stringify(buildCity(toyGraph()))).toBe(JSON.stringify(buildCity(toyGraph())));
  });
});

describe("buildCity: on real extractor output", () => {
  const graph = javaGraph();

  it("builds a city from the committed Java fixture", () => {
    const city = buildCity(graph, { view: internalOnly, carry: ["methods", "fanIn", "fanOut"] });
    expect(city.districts.length).toBeGreaterThan(0);
    expect(city.buildings.length).toBeGreaterThan(city.districts.length);
    expect(city.arrows.length).toBeGreaterThan(0);
    // Every building stands on ground the city declares, and every arrow
    // connects two buildings it declares — the city's own closure property.
    const districts = new Set(city.districts.map((district) => district.id));
    const buildings = new Set(city.buildings.map((building) => building.id));
    for (const building of city.buildings) expect(districts.has(building.district)).toBe(true);
    for (const arrow of city.arrows) {
      expect(buildings.has(arrow.from)).toBe(true);
      expect(buildings.has(arrow.to)).toBe(true);
    }
  });

  it("gives every building a positive height and footprint", () => {
    const city = buildCity(graph);
    for (const building of city.buildings) {
      expect(building.height).toBeGreaterThan(0);
      expect(building.footprint.width).toBeGreaterThan(0);
      expect(building.footprint.depth).toBeGreaterThan(0);
    }
  });
});

describe("buildCity: corpus name", () => {
  it("names the corpus after the model root and reports the roots", () => {
    expect(buildCity(toyGraph()).corpus).toEqual({ name: "test", roots: ["test"] });
  });

  it("joins deduped, sorted root basenames for a multi-root union", () => {
    const graph = graphOfModels([
      { root: "fixtures/java/src", entities: [pkg("java:a"), type("java:a/A", "java:a", 5)] },
      { root: "other/api/", entities: [pkg("java:b"), type("java:b/B", "java:b", 5)] },
    ]);
    expect(buildCity(graph).corpus).toEqual({
      name: "api + src",
      roots: ["fixtures/java/src", "other/api/"],
    });
  });

  it("lets the caller override the derived name", () => {
    const city = buildCity(toyGraph(), { name: "acme" });
    expect(city.corpus.name).toBe("acme");
    expect(city.corpus.roots).toEqual(["test"]);
  });

  it("falls back when no root yields a basename", () => {
    const graph = graphOfModels([
      { root: "", entities: [pkg("java:a"), type("java:a/A", "java:a", 5)] },
    ]);
    expect(buildCity(graph).corpus).toEqual({ name: "codegraph", roots: [] });
  });
});

describe("buildCity: members on buildings", () => {
  it("lists attributes and operations on every building, sorted", () => {
    const city = buildCity(toyGraph());
    const big = city.buildings.find((building) => building.id === "java:a/Big");
    expect(big?.operations).toEqual([
      { signature: "java:a/Big.run()" },
      { signature: "java:a/Big.stop()" },
    ]);
    expect(big?.attributes).toEqual([{ name: "java:a/Big.state" }]);
    const small = city.buildings.find((building) => building.id === "java:a/Small");
    expect(small?.attributes).toEqual([]);
    expect(small?.operations).toEqual([]);
  });

  it("resolves an attribute's declaredType to a name, never a raw id", () => {
    const graph = graphOf([
      pkg("java:a"),
      type("java:a/T", "java:a", 5),
      type("java:a/Other", "java:a", 5, { name: "Other" }),
      { ...field("java:a/T.x", "java:a/T"), declaredType: "java:a/Other" } as Entity,
      { ...field("java:a/T.y", "java:a/T"), declaredType: "java:gone/Missing" } as Entity,
    ]);
    const t = buildCity(graph).buildings.find((building) => building.id === "java:a/T");
    // x resolves through the graph; y's type is unknown, so the key is absent —
    // an unresolvable type never leaks as an id string.
    expect(t?.attributes).toEqual([{ name: "java:a/T.x", type: "Other" }, { name: "java:a/T.y" }]);
  });

  it("agrees with the methods and fields metrics on every real building", () => {
    const city = buildCity(javaGraph(), { carry: ["methods", "fields"] });
    for (const building of city.buildings) {
      expect(building.operations.length).toBe(building.metrics["methods"] ?? 0);
      expect(building.attributes.length).toBe(building.metrics["fields"] ?? 0);
    }
  });
});

describe("buildCity: identity display components", () => {
  it("emits the components core itself decodes from the rendered id", () => {
    const city = buildCity(toyGraph());
    const big = city.buildings.find((building) => building.id === "java:a/Big");
    expect(big?.identity).toEqual({ lang: "java", module: "a", symbol: "Big" });
    expect(Object.keys(big?.identity ?? {})).not.toContain("disambiguator");
    const district = city.districts.find((candidate) => candidate.id === "java:a");
    expect(district?.identity).toEqual({ lang: "java", module: "a", symbol: "" });
  });

  it("round-trips every emitted identity back to its id", () => {
    const city = buildCity(javaGraph());
    for (const element of [...city.buildings, ...city.districts]) {
      expect(element.identity).toBeDefined();
      if (element.identity !== undefined) expect(renderId(element.identity)).toBe(element.id);
    }
  });

  it("omits identity for an id that is not a rendered id, and still builds", () => {
    const graph = graphOf([pkg("weird"), type("weird/T", "weird", 5)]);
    const city = buildCity(graph);
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0]?.identity).toBeUndefined();
    expect(city.districts[0]?.identity).toBeUndefined();
  });
});
