import type { DepRow, NavigatorModel, NavNode } from "@codegraph/navigator";
import type { VocabularyArtifact, VocabularyScope } from "@codegraph/vocabulary";

/**
 * A hand-built artifact — the UI's own unit tests must not depend on the
 * builder running, only on the artifact CONTRACT.
 *
 *   p (module)
 *     A (type)         m() operation, f attribute
 *     C (type)         n() operation
 */
export function artifact(): NavigatorModel {
  const nodes: NavNode[] = [
    { name: "p", id: "java:p/p", kind: "package", category: "module", isStub: false, children: [1, 4] },
    {
      name: "A",
      id: "java:p/A",
      kind: "class",
      category: "type",
      isStub: false,
      parent: 0,
      children: [2, 3],
      metrics: { fanIn: 0, fanOut: 1, instability: 1 },
    },
    { name: "m", kind: "method", category: "operation", isStub: false, parent: 1, children: [], signature: "m()" },
    { name: "f", kind: "attribute", category: "attribute", isStub: false, parent: 1, children: [] },
    {
      name: "C",
      id: "java:p/C",
      kind: "class",
      category: "type",
      isStub: false,
      parent: 0,
      children: [5],
      metrics: { fanIn: 1, fanOut: 0, instability: 0 },
    },
    { name: "n", kind: "method", category: "operation", isStub: false, parent: 4, children: [], signature: "n()" },
  ];
  const deps: DepRow[] = [
    { role: "invokes", from: 1, to: 4, member: 2, toMember: 5, provenance: "declared", anchor: [0, 3, 3] },
    { role: "fieldType", from: 1, to: 4, member: 3, provenance: "declared", anchor: [0, 1, 1] },
    { role: "typeReference", from: 1, to: 4, provenance: "derived", anchor: [0, 2, 2] },
  ];
  return {
    kind: "codegraph.navigator/1",
    generatedBy: "@codegraph/navigator",
    view: { name: "all", filters: [] },
    corpus: { name: "toy", roots: ["toy"] },
    files: ["A.java"],
    nodes,
    roots: [0],
    deps,
    diagnostics: { selfDeps: 0, droppedDeps: 0 },
  };
}

const ROLES = { module: 0, type: 0, operation: 0, attribute: 0, parameter: 0, local: 0, other: 0 };

function scope(
  level: VocabularyScope["level"],
  name: string,
  terms: VocabularyScope["terms"],
  extra: { id?: string; kind?: string; parent?: number } = {},
): VocabularyScope {
  return {
    level,
    ...extra,
    name,
    entities: terms.length,
    roles: ROLES,
    skipped: { unnamed: 0, conventional: 0, numeric: 0 },
    distinct: terms.length,
    distinctDomain: 0,
    weight: terms.reduce((sum, row) => sum + row[1], 0),
    occurrences: terms.reduce((sum, row) => sum + row[2], 0),
    terms,
  };
}

/**
 * The words of the toy above, by hand — the CONTRACT again, not the builder:
 * the corpus, module p, types A and C, with the navigator's ids.
 */
export function vocabularyArtifact(): VocabularyArtifact {
  return {
    kind: "codegraph.vocabulary/1",
    generatedBy: "@codegraph/vocabulary",
    view: { name: "all", filters: [] },
    corpus: { name: "toy", roots: ["toy"] },
    langs: ["java"],
    weights: { module: 8, type: 8, operation: 3, attribute: 4, parameter: 1, local: 1, other: 1, qualifier: 1 },
    classes: ["domain", "technical", "keyword", "short"],
    technical: { words: 138, sha256: "4f34e69f52f5".padEnd(64, "0") },
    terms: [
      { text: "account", class: "domain", modules: 1, types: 1, exclusive: 1 },
      { text: "get", class: "technical", modules: 1, types: 1, exclusive: 1 },
      { text: "new", class: "keyword", modules: 1, types: 1, exclusive: 1 },
      { text: "order", class: "domain", modules: 1, types: 2, exclusive: 1 },
      { text: "x", class: "short", modules: 1, types: 1, exclusive: 1 },
    ],
    scopes: [
      scope("corpus", "toy", [[3, 19, 3, 3], [0, 8, 1, 1], [1, 3, 1, 1], [2, 1, 1, 1], [4, 1, 1, 1]]),
      scope("module", "p", [[3, 19, 3, 3], [0, 8, 1, 1], [1, 3, 1, 1], [2, 1, 1, 1], [4, 1, 1, 1]], { id: "java:p/p", kind: "package", parent: 0 }),
      scope("type", "A", [[3, 11, 2, 2], [1, 3, 1, 1], [4, 1, 1, 1]], { id: "java:p/A", kind: "class", parent: 1 }),
      scope("type", "C", [[0, 8, 1, 1], [3, 8, 1, 1], [2, 1, 1, 1]], { id: "java:p/C", kind: "class", parent: 1 }),
    ],
    diagnostics: { unplaced: [], withoutLexicon: [] },
  };
}
