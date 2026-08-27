import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ModelDecoder, decodeModel, encodeModel, encodeModelToString, JsonlError } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { SCHEMA_VERSION, parseModel, type Model } from "../src/model.js";
import { HeaderRec } from "../src/wire.js";

/**
 * The JSONL interchange (docs/model-encoding.md §2). The tests that matter are
 * the ones about LOSS: what a round trip must preserve, what it must drop on
 * purpose, and which malformed files must be refused rather than half-read.
 */

const fixture = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

/** The real extractor output — 166 entities of genuinely awkward Java. */
function loadFixture(): Model {
  return parseModel(readModelFileSync(fixture));
}

/** A v1-era model: the same entities, with the `children` key put back on. */
function withChildren(model: Model): Model {
  const childrenOf = new Map<string, string[]>();
  for (const entity of model.entities) {
    const parent = (entity as Record<string, unknown>)["parent"];
    if (typeof parent === "string") {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), entity.id]);
    }
  }
  return {
    ...model,
    entities: model.entities.map((entity) =>
      entity.traits.includes("TWithChildren")
        ? ({ ...entity, children: childrenOf.get(entity.id) ?? [] } as typeof entity)
        : entity,
    ),
  };
}

function byId(model: Model): Map<string, unknown> {
  return new Map(model.entities.map((entity) => [entity.id, entity]));
}

function lines(model: Model): string[] {
  return [...encodeModel(model)];
}

describe("round trip on the real fixture corpus", () => {
  const model = loadFixture();
  const text = encodeModelToString(model);
  const back = decodeModel(text.split("\n"));

  it("preserves every entity, key for key", () => {
    const before = byId(model);
    const after = byId(back);
    expect(after.size).toBe(before.size);
    for (const [id, entity] of before) expect(after.get(id)).toEqual(entity);
  });

  it("preserves every edge", () => {
    const key = (edge: unknown): string => JSON.stringify(edge);
    expect(back.edges.map(key).sort()).toEqual(model.edges.map(key).sort());
  });

  it("preserves the header facts", () => {
    expect(back.schemaVersion).toBe(model.schemaVersion);
    expect(back.lang).toBe(model.lang);
    expect(back.root).toBe(model.root);
    expect(back.extractor).toEqual(model.extractor);
  });

  /**
   * The claim the whole format rests on: identity travels as `(m, s, d)`, so
   * not one rendered id string is written to the file.
   */
  it("contains no rendered id anywhere in the file", () => {
    for (const entity of model.entities) expect(text).not.toContain(entity.id);
  });

  /**
   * MM-2: `children` is the exact inverse of `parent`. A v1-era model carrying
   * it is not carrying an extension — the key is DROPPED, or the format would
   * re-serialize the very index it removed.
   */
  it("drops `children` — the inverse of `parent` (MM-2)", () => {
    const v1 = withChildren(model);
    expect(v1.entities.filter((e) => "children" in (e as object)).length).toBeGreaterThan(0);

    const encoded = encodeModelToString(v1);
    expect(encoded).not.toContain('"children"');
    const decoded = decodeModel(encoded.split("\n"));
    for (const entity of decoded.entities) expect(entity).not.toHaveProperty("children");
    // The trait itself stays: it says "this is a container".
    expect(decoded.entities.some((e) => e.traits.includes("TWithChildren"))).toBe(true);
    // And nothing else changed: dropping a derived key is not losing data.
    expect(decoded.entities.map((e) => e.id)).toEqual(back.entities.map((e) => e.id));
  });

  it("is smaller than the same model as one JSON document", () => {
    expect(text.length).toBeLessThan(JSON.stringify(model).length);
  });

  it("is byte-identical across runs", () => {
    expect(encodeModelToString(model)).toBe(text);
  });

  it("is byte-identical however the extractor happened to order its output", () => {
    const shuffled: Model = {
      ...model,
      entities: [...model.entities].reverse(),
      edges: [...model.edges].reverse(),
    };
    expect(encodeModelToString(shuffled)).toBe(text);
  });
});

describe("repository provenance rides in the header (M10a)", () => {
  const repository = {
    remote: "https://github.com/google/gson",
    commit: "4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1",
    root: "gson/src/main/java",
  } as const;

  it("survives a round trip, verbatim", () => {
    const model: Model = { ...loadFixture(), repository };
    const back = decodeModel(encodeModelToString(model).split("\n"));
    expect(back.repository).toEqual(repository);
    expect(HeaderRec.parse(JSON.parse(lines(model)[0]!)).repository).toEqual(repository);
  });

  it("is absent from the header of a model that has none — absence is honest", () => {
    const model = loadFixture();
    expect(lines(model)[0]).not.toContain("repository");
    expect(decodeModel(encodeModelToString(model).split("\n")).repository).toBeUndefined();
  });

  it("refuses a header whose repository is not the normalized form", () => {
    const model: Model = {
      ...loadFixture(),
      // Cast: the writer trusts its input, so the refusal must come from the READER.
      repository: { ...repository, remote: "git@github.com:google/gson.git" } as never,
    };
    expect(() => decodeModel(encodeModelToString(model).split("\n"))).toThrow(/header/);
  });
});

describe("the container contract — section order and the trailer", () => {
  const model = loadFixture();

  it("emits header, files, entities, edges, eof in that order", () => {
    const tags = lines(model).map((line) => (JSON.parse(line) as { t: string }).t);
    expect(tags[0]).toBe("header");
    expect(tags.at(-1)).toBe("eof");
    const order = ["header", "f", "e", "x", "eof"];
    let at = 0;
    for (const tag of tags) {
      const rank = order.indexOf(tag);
      expect(rank).toBeGreaterThanOrEqual(at);
      at = rank;
    }
  });

  it("declares the vocabularies it uses in the header (MM-3)", () => {
    const header = HeaderRec.parse(JSON.parse(lines(model)[0]!));
    expect(header.dict.kinds).toEqual([...header.dict.kinds].sort());
    expect(header.dict.traits.length).toBeGreaterThan(0);
    expect(header.dict.provenance).toContain("declared");
  });

  it("counts what it wrote, so truncation is detectable", () => {
    const all = lines(model);
    const eof = JSON.parse(all.at(-1)!) as { counts: Record<string, number> };
    expect(eof.counts["entities"]).toBe(model.entities.length);
    expect(eof.counts["edges"]).toBe(model.edges.length);
  });

  it("refuses a file with no eof record — the writer may have been killed", () => {
    const all = lines(model);
    expect(() => decodeModel(all.slice(0, -1))).toThrow(/truncated/);
  });

  it("refuses a file whose eof disagrees with its content", () => {
    const all = lines(model);
    const withoutLastEdge = [...all.slice(0, -2), all.at(-1)!];
    expect(() => decodeModel(withoutLastEdge)).toThrow(/eof declares .* edges but the file carries/);
  });

  it("refuses a record before the header", () => {
    expect(() => decodeModel(['{"t":"f","i":0,"path":"A.java"}'])).toThrow(/record before the header/);
  });

  it("refuses a section that reopens", () => {
    const all = lines(model);
    const firstFile = all.find((line) => line.startsWith('{"t":"f"'))!;
    const scrambled = [...all.slice(0, -1), firstFile, all.at(-1)!];
    expect(() => decodeModel(scrambled)).toThrow(/after the section it belongs to closed/);
  });

  it("refuses an unknown record type rather than skipping it", () => {
    const all = lines(model);
    const withJunk = [...all.slice(0, -1), '{"t":"ts","x":1}', all.at(-1)!];
    expect(() => decodeModel(withJunk)).toThrow(/unknown record type/);
  });

  it("names the line a malformed record is on", () => {
    const all = lines(model);
    const broken = [...all.slice(0, 2), "{not json", ...all.slice(2)];
    expect(() => decodeModel(broken)).toThrow(/line 3: not JSON/);
  });

  it("ignores blank lines", () => {
    const all = lines(model);
    expect(decodeModel([...all, "", "  "]).entities.length).toBe(model.entities.length);
  });
});

describe("references are surrogates, and closure is checked as they resolve", () => {
  const model = loadFixture();

  it("refuses an edge pointing past the last entity", () => {
    const all = lines(model);
    const at = all.findIndex((line) => line.startsWith('{"t":"x"'));
    const edge = JSON.parse(all[at]!) as Record<string, unknown>;
    edge["o"] = model.entities.length + 5;
    const broken = [...all.slice(0, at), JSON.stringify(edge), ...all.slice(at + 1)];
    expect(() => decodeModel(broken)).toThrow(/closure/);
  });

  it("refuses an entity whose module is declared later", () => {
    const all = lines(model);
    const at = all.findIndex((line) => line.startsWith('{"t":"e"'));
    const entity = JSON.parse(all[at]!) as Record<string, unknown>;
    entity["m"] = model.entities.length - 1;
    const broken = [...all.slice(0, at), JSON.stringify(entity), ...all.slice(at + 1)];
    expect(() => decodeModel(broken)).toThrow(/declared later/);
  });

  it("refuses an out-of-order surrogate", () => {
    const all = lines(model);
    const at = all.findIndex((line) => line.startsWith('{"t":"e"'));
    const entity = JSON.parse(all[at]!) as Record<string, unknown>;
    entity["i"] = 7;
    const broken = [...all.slice(0, at), JSON.stringify(entity), ...all.slice(at + 1)];
    expect(() => decodeModel(broken)).toThrow(/out of order/);
  });

  it("refuses a dictionary index the header never declared", () => {
    const all = lines(model);
    const at = all.findIndex((line) => line.startsWith('{"t":"x"'));
    const edge = JSON.parse(all[at]!) as Record<string, unknown>;
    edge["k"] = 99;
    const broken = [...all.slice(0, at), JSON.stringify(edge), ...all.slice(at + 1)];
    expect(() => decodeModel(broken)).toThrow(/not in the header dictionary/);
  });
});

describe("what the encoder refuses to write", () => {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    lang: "demo",
    extractor: { name: "test", version: "0" },
    root: "/corpus",
  };
  const moduleEntity = {
    id: "demo:m",
    kind: "package",
    traits: ["TNamed", "TModule"],
    name: "m",
    definedIn: [],
    isStub: false,
  };

  it("refuses two entities claiming one natural key", () => {
    const model = parseModel({
      ...base,
      entities: [moduleEntity, { id: "demo:m/A", kind: "class", traits: [] }, { id: "demo:m/A", kind: "class", traits: [] }],
      edges: [],
    });
    expect(() => encodeModelToString(model)).toThrow(/duplicate natural key: demo:m\/A/);
  });

  it("refuses an entity whose module no entity declares", () => {
    const model = parseModel({
      ...base,
      entities: [{ id: "demo:orphan/A", kind: "class", traits: [] }],
      edges: [],
    });
    expect(() => encodeModelToString(model)).toThrow(/declares no module entity/);
  });

  it("refuses an edge to an entity the model does not declare", () => {
    const model = parseModel({
      ...base,
      entities: [moduleEntity, { id: "demo:m/A", kind: "class", traits: [] }],
      edges: [
        {
          edge: "invocation",
          from: "demo:m/A",
          to: "demo:m/Nowhere",
          provenance: "declared",
          anchor: { file: "A.java", span: [1, 1] },
        },
      ],
    });
    expect(() => encodeModelToString(model)).toThrow(/references an entity this model does not declare/);
  });
});

describe("a module names itself, which is what makes every reference an int", () => {
  const model = parseModel({
    schemaVersion: SCHEMA_VERSION,
    lang: "demo",
    extractor: { name: "test", version: "0" },
    root: "/corpus",
    entities: [
      { id: "demo:a.b", kind: "package", traits: ["TNamed", "TModule"], name: "b", definedIn: ["A.java"], isStub: false },
      { id: "demo:a.b/T", kind: "class", traits: ["TNamed", "TChildOf"], name: "T", parent: "demo:a.b" },
      { id: "demo:a.b/T.m(int)", kind: "method", traits: ["TNamed", "TChildOf"], name: "m", parent: "demo:a.b/T" },
      { id: "demo:a.b/T#A.java:9", kind: "lambda", traits: ["TChildOf"], parent: "demo:a.b/T.m(int)" },
    ],
    edges: [],
  });
  const records = lines(model).map((line) => JSON.parse(line) as Record<string, unknown>);
  const entities = records.filter((record) => record["t"] === "e");

  it("writes the module's own path in its symbol slot, pointing at itself", () => {
    expect(entities[0]).toMatchObject({ i: 0, m: 0, s: "a.b" });
  });

  it("writes members as a symbol under their module's surrogate", () => {
    expect(entities[1]).toMatchObject({ i: 1, m: 0, s: "T" });
    expect(entities[3]).toMatchObject({ m: 0, s: "T.m(int)" });
  });

  // Canonical order puts the bare symbol before any disambiguated form of it,
  // so the lambda `T#A.java:9` sorts between `T` and `T.m(int)`.
  it("keeps the anonymous-entity disambiguator separate from the symbol", () => {
    expect(entities[2]).toMatchObject({ m: 0, s: "T", d: "A.java:9" });
  });

  it("rebuilds every rendered id exactly", () => {
    expect(decodeModel(lines(model)).entities.map((e) => e.id)).toEqual([
      "demo:a.b",
      "demo:a.b/T",
      "demo:a.b/T#A.java:9",
      "demo:a.b/T.m(int)",
    ]);
  });
});

describe("an entity attached straight to its module", () => {
  /**
   * Empty symbol plus a disambiguator — a top-level lambda in a language that
   * has them. The module test cannot be "empty symbol" alone, or this entity
   * would shadow the real module and inherit its path.
   */
  const model = parseModel({
    schemaVersion: SCHEMA_VERSION,
    lang: "demo",
    extractor: { name: "test", version: "0" },
    root: "/corpus",
    entities: [
      { id: "demo:a.b", kind: "package", traits: ["TModule"], definedIn: [], isStub: false },
      { id: "demo:a.b#A.demo:3", kind: "lambda", traits: [] },
    ],
    edges: [],
  });

  it("round-trips without stealing the module's path", () => {
    const records = lines(model).map((line) => JSON.parse(line) as Record<string, unknown>);
    const entities = records.filter((record) => record["t"] === "e");
    expect(entities[0]).toMatchObject({ i: 0, m: 0, s: "a.b" });
    expect(entities[1]).toMatchObject({ i: 1, m: 0, s: "", d: "A.demo:3" });
    expect(decodeModel(lines(model)).entities.map((e) => e.id)).toEqual([
      "demo:a.b",
      "demo:a.b#A.demo:3",
    ]);
  });
});

describe("extension keys", () => {
  it("carries a key no trait contributes through the round trip", () => {
    const model = parseModel({
      schemaVersion: SCHEMA_VERSION,
      lang: "demo",
      extractor: { name: "test", version: "0" },
      root: "/corpus",
      entities: [
        { id: "demo:m", kind: "package", traits: ["TModule"], definedIn: [], isStub: false },
        { id: "demo:m/A", kind: "class", traits: [], vendorFlag: "keep me" },
      ],
      edges: [],
    });
    const back = decodeModel(lines(model));
    expect(back.entities.find((e) => e.id === "demo:m/A")).toHaveProperty("vendorFlag", "keep me");
  });
});

describe("the incremental decoder", () => {
  it("refuses to be finished twice", () => {
    const decoder = new ModelDecoder();
    for (const line of lines(loadFixture())) decoder.push(line);
    decoder.finish();
    expect(() => decoder.finish()).toThrow(/already called/);
  });

  it("exposes the natural keys it decoded, by surrogate", () => {
    const decoder = new ModelDecoder();
    for (const line of lines(loadFixture())) decoder.push(line);
    const model = decoder.finish();
    expect(decoder.keys.length).toBe(model.entities.length);
    expect(decoder.keys[0]!.lang).toBe("java");
  });

  it("reports an empty file as such", () => {
    expect(() => new ModelDecoder().finish()).toThrow(JsonlError);
    expect(() => new ModelDecoder().finish()).toThrow(/empty file/);
  });
});
