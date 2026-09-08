import { compareKeys, compareText, isModuleKey, keyIndex, renderKey, type Key } from "./keys.js";
import type { Anchor, Edge, Entity, Literal, Model, NamedArgument } from "./model.js";

/**
 * The JSONL writer (schemas/README.md): one record per line in canonical
 * order, every reference a surrogate, every path interned, every closed
 * vocabulary an index into the header's dictionaries. Written to match
 * core's own encoder byte for byte — JSON.stringify IS the reference
 * serializer, so the only thing to get right is the order of everything.
 */

const SCHEMA_VERSION = "1.0.0";

/** The key order every entity record is written in (core's ENTITY_KEY_ORDER). */
const ENTITY_KEY_ORDER = [
  "name",
  "signature",
  "declaredType",
  "isStub",
  "parent",
  "attachedTo",
  "parameters",
  "localVariables",
  "definedIn",
  "comments",
  "metrics",
  "value",
  "space",
  "anchor",
] as const;

export class ModelWriteError extends Error {
  override name = "ModelWriteError";
}

function sortedDistinct(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

/** Model → lines, canonical order. The caller adds the LF and decides where bytes go. */
export function* encode(model: Model): Generator<string> {
  // 1. Canonical order is the surrogate assignment.
  const entities = [...model.entities].sort((a, b) => compareKeys(a.key, b.key));
  const surrogateOf = new Map<string, number>();
  entities.forEach((entity, index) => {
    const at = keyIndex(entity.key);
    if (surrogateOf.has(at)) throw new ModelWriteError(`duplicate natural key: ${renderKey(entity.key)}`);
    surrogateOf.set(at, index);
  });

  // 2. A module names itself: the entity with an empty, undisambiguated symbol.
  const moduleSurrogate = new Map<string, number>();
  entities.forEach((entity, index) => {
    if (isModuleKey(entity.key) && !moduleSurrogate.has(entity.key.module)) {
      moduleSurrogate.set(entity.key.module, index);
    }
  });

  const refOf = (key: Key, from: string): number => {
    const surrogate = surrogateOf.get(keyIndex(key));
    if (surrogate === undefined) {
      throw new ModelWriteError(`${from} references an entity this model does not declare: ${renderKey(key)}`);
    }
    return surrogate;
  };

  // 3. The file table: every path any record can name, interned once, sorted.
  const paths = new Set<string>();
  for (const entity of entities) {
    if (entity.anchor !== undefined) paths.add(entity.anchor.file);
    for (const path of entity.definedIn ?? []) paths.add(path);
  }
  for (const edge of model.edges) {
    paths.add(edge.anchor.file);
    if (edge.sourceFile !== undefined) paths.add(edge.sourceFile);
  }
  const files = [...paths].sort(compareText);
  const fileIndex = new Map(files.map((path, index) => [path, index]));
  const fileRef = (path: string): number => {
    const index = fileIndex.get(path);
    if (index === undefined) throw new ModelWriteError(`unknown path: ${path}`);
    return index;
  };
  const wireAnchor = (anchor: Anchor): [number, number, number] => [
    fileRef(anchor.file),
    anchor.span[0],
    anchor.span[1],
  ];

  // 4. Dictionaries: what this model actually uses, sorted.
  const dict = {
    kinds: sortedDistinct(entities.map((entity) => entity.kind)),
    traits: sortedDistinct(entities.flatMap((entity) => entity.traits)),
    edges: sortedDistinct(model.edges.map((edge) => edge.kind)),
    provenance: sortedDistinct(model.edges.map((edge) => edge.provenance)),
  };
  const indexOf = (values: readonly string[]): ((value: string) => number) => {
    const map = new Map(values.map((value, index) => [value, index]));
    return (value) => map.get(value) as number;
  };
  const kindRef = indexOf(dict.kinds);
  const traitRef = indexOf(dict.traits);
  const edgeKindRef = indexOf(dict.edges);
  const provenanceRef = indexOf(dict.provenance);

  yield JSON.stringify({
    t: "header",
    schemaVersion: SCHEMA_VERSION,
    lang: model.lang,
    extractor: model.extractor,
    root: model.root,
    ...(model.repository === undefined ? {} : { repository: model.repository }),
    dict,
  });

  for (const [index, path] of files.entries()) {
    yield JSON.stringify({ t: "f", i: index, path });
  }

  for (const [index, entity] of entities.entries()) {
    const moduleIndex = moduleSurrogate.get(entity.key.module);
    if (moduleIndex === undefined) {
      throw new ModelWriteError(
        `entity ${renderKey(entity.key)} names module "${entity.key.module}", which declares no module entity`,
      );
    }
    const record: Record<string, unknown> = {
      t: "e",
      i: index,
      k: kindRef(entity.kind),
      tr: entity.traits.map(traitRef),
      m: moduleIndex,
      // A module writes its own path in the symbol slot; everything else its
      // path below the module — empty for a nameless top-level entity.
      s: index === moduleIndex ? entity.key.module : entity.key.symbol,
    };
    if (entity.key.disambiguator !== undefined) record["d"] = entity.key.disambiguator;

    const owner = renderKey(entity.key);
    for (const wireKey of ENTITY_KEY_ORDER) {
      const value = entity[wireKey];
      if (value === undefined) continue;
      record[wireKey] = encodeValue(wireKey, value, owner);
    }
    yield JSON.stringify(record);
  }

  const edges = model.edges
    .map((edge) => ({
      edge,
      f: refOf(edge.from, `edge ${edge.kind}`),
      o: refOf(edge.to, `edge ${edge.kind}`),
    }))
    .sort(
      (a, b) =>
        a.f - b.f ||
        a.o - b.o ||
        compareText(a.edge.kind, b.edge.kind) ||
        fileRef(a.edge.anchor.file) - fileRef(b.edge.anchor.file) ||
        a.edge.anchor.span[0] - b.edge.anchor.span[0] ||
        a.edge.anchor.span[1] - b.edge.anchor.span[1] ||
        compareText(a.edge.provenance, b.edge.provenance),
    );

  for (const { edge, f, o } of edges) {
    const record: Record<string, unknown> = {
      t: "x",
      k: edgeKindRef(edge.kind),
      f,
      o,
      p: provenanceRef(edge.provenance),
    };
    if (edge.candidates !== undefined) {
      record["candidates"] = edge.candidates.map((key) => refOf(key, "edge candidates"));
    }
    // Omitted when empty: the edge KIND already says the key is there.
    if (edge.arguments !== undefined && edge.arguments.length > 0) {
      record["arguments"] = encodeArguments(edge.arguments, "annotation argument");
    }
    if (edge.isRead !== undefined) record["isRead"] = edge.isRead;
    if (edge.isWrite !== undefined) record["isWrite"] = edge.isWrite;
    if (edge.sourceFile !== undefined) record["sourceFile"] = fileRef(edge.sourceFile);
    record["anchor"] = wireAnchor(edge.anchor);
    yield JSON.stringify(record);
  }

  yield JSON.stringify({
    t: "eof",
    counts: { files: files.length, entities: entities.length, edges: edges.length },
  });

  function encodeValue(key: string, value: unknown, owner: string): unknown {
    switch (key) {
      case "anchor":
        return wireAnchor(value as Anchor);
      case "definedIn":
        return (value as string[]).map(fileRef);
      case "metrics": {
        // Key-sorted: canonical order reaches inside the record.
        const metrics = value as Record<string, number>;
        const sorted: Record<string, number> = {};
        for (const name of Object.keys(metrics).sort(compareText)) sorted[name] = metrics[name] as number;
        return sorted;
      }
      case "value":
        return encodeLiteral(value as Literal, `${owner}.value`);
      case "declaredType":
      case "parent":
      case "attachedTo":
        return refOf(value as Key, `${owner}.${key}`);
      case "parameters":
      case "localVariables":
        return (value as Key[]).map((ref) => refOf(ref, `${owner}.${key}`));
      default:
        return value;
    }
  }

  function encodeLiteral(value: Literal, from: string): unknown {
    switch (value.k) {
      case "enum":
        return { k: "enum", type: refOf(value.type, from), name: value.name };
      case "type":
        return { k: "type", type: refOf(value.type, from) };
      case "array":
        return { k: "array", items: value.items.map((item) => encodeLiteral(item, from)) };
      case "annotation":
        return {
          k: "annotation",
          type: refOf(value.type, from),
          arguments: encodeArguments(value.arguments, from),
        };
      default:
        return value;
    }
  }

  function encodeArguments(args: readonly NamedArgument[], from: string): unknown[] {
    return args.map((argument) => ({ name: argument.name, value: encodeLiteral(argument.value, from) }));
  }
}

/** The whole file as one string — LF-terminated lines, UTF-8 when written. */
export function encodeToString(model: Model): string {
  let out = "";
  for (const line of encode(model)) out += `${line}\n`;
  return out;
}

/** How many lines `encode` will yield: header + files + entities + edges + eof. */
export function plannedRecords(model: Model): number {
  const paths = new Set<string>();
  for (const entity of model.entities) {
    if (entity.anchor !== undefined) paths.add(entity.anchor.file);
    for (const path of entity.definedIn ?? []) paths.add(path);
  }
  for (const edge of model.edges) {
    paths.add(edge.anchor.file);
    if (edge.sourceFile !== undefined) paths.add(edge.sourceFile);
  }
  return 2 + paths.size + model.entities.length + model.edges.length;
}
