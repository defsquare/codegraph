import type { DepRow, NavigatorModel, NavNode } from "@codegraph/navigator";

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
    { name: "p", kind: "package", category: "module", isStub: false, children: [1, 4] },
    {
      name: "A",
      kind: "class",
      category: "type",
      isStub: false,
      parent: 0,
      children: [2, 3],
      metrics: { fanIn: 0, fanOut: 1 },
    },
    { name: "m", kind: "method", category: "operation", isStub: false, parent: 1, children: [], signature: "m()" },
    { name: "f", kind: "attribute", category: "attribute", isStub: false, parent: 1, children: [] },
    {
      name: "C",
      kind: "class",
      category: "type",
      isStub: false,
      parent: 0,
      children: [5],
      metrics: { fanIn: 1, fanOut: 0 },
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
