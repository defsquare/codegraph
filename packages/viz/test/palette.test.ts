import { describe, expect, it } from "vitest";
import {
  cssToHex,
  DEFAULT_PALETTE,
  hexToCss,
  parsePalette,
  serializePalette,
} from "../src/scene/palette.js";

describe("the default palette is the architect's-model scheme", () => {
  it("colors buildings verdigris teal — off every accent hue", () => {
    expect(DEFAULT_PALETTE.building).toBe(0x4e8c86);
  });
  it("colors stubs a washed pale of the same family — the model knows less", () => {
    expect(DEFAULT_PALETTE.buildingStub).toBe(0xa3b5b0);
  });
  it("colors district plates cool paper, between ground and background", () => {
    expect(DEFAULT_PALETTE.districtPlate).toBe(0xc9d0da);
  });
});

describe("hex <-> css conversion", () => {
  it("renders a number as a #rrggbb string, zero-padded", () => {
    expect(hexToCss(0x172741)).toBe("#172741");
    expect(hexToCss(0x00000f)).toBe("#00000f");
  });
  it("parses #rrggbb case-insensitively", () => {
    expect(cssToHex("#F65E5E")).toBe(0xf65e5e);
    expect(cssToHex("#e2ca9e")).toBe(0xe2ca9e);
  });
  it("rejects anything that is not exactly #rrggbb", () => {
    expect(cssToHex("172741")).toBeNull();
    expect(cssToHex("#fff")).toBeNull();
    expect(cssToHex("#17274g")).toBeNull();
    expect(cssToHex("")).toBeNull();
  });
});

describe("parsePalette — what localStorage hands back", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(parsePalette(null)).toEqual(DEFAULT_PALETTE);
  });
  it("returns the defaults on garbage", () => {
    expect(parsePalette("not json")).toEqual(DEFAULT_PALETTE);
    expect(parsePalette("[1,2]")).toEqual(DEFAULT_PALETTE);
    expect(parsePalette("42")).toEqual(DEFAULT_PALETTE);
  });
  it("merges stored keys over the defaults, so a partial store still works", () => {
    expect(parsePalette('{"building":"#f65e5e"}')).toEqual({
      ...DEFAULT_PALETTE,
      building: 0xf65e5e,
    });
  });
  it("ignores invalid or unknown keys, keeping the default for each", () => {
    expect(parsePalette('{"building":"red","ground":"#000000"}')).toEqual(DEFAULT_PALETTE);
  });
  it("round-trips through serializePalette", () => {
    const palette = { building: 0xf65e5e, buildingStub: 0x0d0c09, districtPlate: 0x3dbf9e };
    expect(parsePalette(serializePalette(palette))).toEqual(palette);
  });
});
