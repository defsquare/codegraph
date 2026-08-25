import { CITY_ARTEFACT_KIND as CANONICAL_KIND } from "@codegraph/city";
import { describe, expect, it } from "vitest";
import { CITY_ARTEFACT_KIND, CityLoadError, parseCityLayout } from "../src/guard.js";
import { makeCity, makeOldCity } from "./fixture.js";

describe("parseCityLayout", () => {
  it("pins the artifact kind the city package actually writes", () => {
    // guard.ts restates the constant so the browser bundle never imports the
    // Node-side city package; this is the drift alarm.
    expect(CITY_ARTEFACT_KIND).toBe(CANONICAL_KIND);
  });

  it("accepts a laid-out city artifact round-tripped through JSON", () => {
    const city = makeCity();
    const parsed = parseCityLayout(JSON.stringify(city));
    expect(parsed).toEqual(city);
  });

  it("accepts an artifact from before corpus, identity and members existed", () => {
    // Back-compat, like the districtArrows default below it: none of the new
    // keys is a hard requirement; the scene models default what is absent.
    const parsed = parseCityLayout(JSON.stringify(makeOldCity()));
    expect((parsed as unknown as Record<string, unknown>)["corpus"]).toBeUndefined();
    expect(parsed.buildings).toHaveLength(4);
  });

  it("rejects non-JSON (a model.jsonl line stream) with the producing command", () => {
    const jsonl = '{"schemaVersion":1}\n{"kind":"module"}\n';
    expect(() => parseCityLayout(jsonl)).toThrow(CityLoadError);
    expect(() => parseCityLayout(jsonl)).toThrow(/codegraph city .*--layout/);
  });

  it("rejects JSON that is not a city artifact, naming the kind it found", () => {
    const text = JSON.stringify({ kind: "something/else", buildings: [] });
    expect(() => parseCityLayout(text)).toThrow(/"something\/else"/);
    expect(() => parseCityLayout(text)).toThrow(/codegraph\.city\/1/);
  });

  it("rejects a city built without --layout, pointing at the flag", () => {
    const { layout: _layout, bounds: _bounds, ...rest } = makeCity() as unknown as Record<
      string,
      unknown
    >;
    const unplaced = {
      ...rest,
      buildings: (rest["buildings"] as Record<string, unknown>[]).map(
        ({ position: _position, ...b }) => b,
      ),
      districts: (rest["districts"] as Record<string, unknown>[]).map(
        ({ bounds: _b, ...d }) => d,
      ),
    };
    expect(() => parseCityLayout(JSON.stringify(unplaced))).toThrow(/--layout/);
  });

  it("passes a well-formed replay block through untouched", () => {
    const replay = { clock: "commits", ticks: [], series: {} };
    const parsed = parseCityLayout(JSON.stringify({ ...(makeCity() as object), replay }));
    expect((parsed as unknown as Record<string, unknown>)["replay"]).toEqual(replay);
  });

  it("rejects a half-shaped replay block — a scrubber must not lie", () => {
    const broken = { ...(makeCity() as object), replay: { ticks: "not-an-array" } };
    expect(() => parseCityLayout(JSON.stringify(broken))).toThrow(/replay/);
    expect(() => parseCityLayout(JSON.stringify(broken))).toThrow(CityLoadError);
  });

  it("rejects conventions this renderer does not implement", () => {
    const city = makeCity({
      conventions: {
        arrowAttachment: "roof",
        heightAxis: "z",
        groundPlane: "xy",
        units: "city",
      } as never,
    });
    expect(() => parseCityLayout(JSON.stringify(city))).toThrow(/conventions/);
  });
});
