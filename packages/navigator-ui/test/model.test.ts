import { describe, expect, it } from "vitest";
import { buildIndexes, ancestorsOf } from "../src/model/indexes.js";
import { expandedToReveal, visibleRows } from "../src/model/flatten.js";
import { foldPackages } from "../src/model/fold.js";
import { searchNodes } from "../src/model/search.js";
import { depsForSelection } from "../src/model/grouping.js";
import { artifact } from "./fixture.js";

const model = artifact();
const ix = buildIndexes(model);
const fold = ix.fold;

describe("indexes", () => {
  it("buckets every dep row by owner and by carrying member", () => {
    expect(ix.depsByFrom.get(1)).toEqual([0, 1, 2]);
    expect(ix.depsByTo.get(4)).toEqual([0, 1, 2]);
    expect(ix.depsByMember.get(2)).toEqual([0]); // m() carries the invocation
    expect(ix.depsByMember.get(3)).toEqual([1]); // f carries the field type
    expect(ix.depsByToMember.get(5)).toEqual([0]); // n() is the invoked member
  });

  it("builds a lowercase search key per node, signatures included", () => {
    expect(ix.searchKeys[2]).toBe("m m()");
    expect(ix.searchKeys[0]).toBe("p");
  });

  it("finds a type or module by the entity id another artifact carries", () => {
    // The city's buildings and districts name these ids; members carry none.
    expect(ix.nodeById.get("java:p/A")).toBe(1);
    expect(ix.nodeById.get("java:p/p")).toBe(0);
    expect(ix.nodeById.size).toBe(3);
  });

  it("walks ancestors root-first", () => {
    expect(ancestorsOf(model, 2)).toEqual([0, 1]);
    expect(ancestorsOf(model, 0)).toEqual([]);
  });
});

describe("the visible-row flattening", () => {
  it("shows only roots when nothing is expanded", () => {
    expect(visibleRows(model, fold, new Set()).map((row) => row.node)).toEqual([0]);
  });

  it("expands in preorder, with depth and expandability per row", () => {
    const rows = visibleRows(model, fold, new Set([0, 1]));
    expect(rows.map((row) => row.node)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 1]);
    expect(rows.map((row) => row.expandable)).toEqual([true, true, false, false, true]);
  });

  it("hides stubs when asked", () => {
    const withStub = {
      ...model,
      nodes: [...model.nodes, { ...model.nodes[4]!, name: "S", isStub: true, children: [] }],
      roots: [0, 6],
    };
    const stubFold = foldPackages(withStub);
    expect(visibleRows(withStub, stubFold, new Set([0])).some((row) => row.node === 6)).toBe(true);
    expect(
      visibleRows(withStub, stubFold, new Set([0]), { hideExternals: true }).some(
        (row) => row.node === 6,
      ),
    ).toBe(false);
  });

  it("reveals a node by expanding exactly its ancestors", () => {
    expect([...expandedToReveal(model, fold, new Set(), 2)].sort()).toEqual([0, 1]);
  });
});

describe("search", () => {
  it("matches names and signatures, case-insensitively", () => {
    expect(searchNodes(ix.searchKeys, "M()").matches).toEqual([2]);
    expect(searchNodes(ix.searchKeys, "a").matches).toEqual([1]);
  });

  it("returns nothing for a blank query", () => {
    expect(searchNodes(ix.searchKeys, "   ").matches).toEqual([]);
  });

  it("caps the result list and says it was capped", () => {
    const keys = Array.from({ length: 50 }, () => "match");
    const result = searchNodes(keys, "match", 10);
    expect(result.matches).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe("grouping for the dependency view", () => {
  it("groups a type's rows by role, in the vocabulary's own order", () => {
    const deps = depsForSelection(ix, 1);
    expect(deps.outgoing.map((group) => group.role)).toEqual([
      "invokes",
      "fieldType",
      "typeReference",
    ]);
    expect(deps.incoming).toEqual([]);
  });

  it("reads a type's incoming rows from the other end", () => {
    const deps = depsForSelection(ix, 4);
    expect(deps.incoming.flatMap((group) => group.rows)).toEqual([0, 1, 2]);
    expect(deps.outgoing).toEqual([]);
  });

  it("gives an operation only the rows IT carries", () => {
    const deps = depsForSelection(ix, 2);
    expect(deps.outgoing.flatMap((group) => group.rows)).toEqual([0]);
    expect(deps.outgoingByMember).toEqual([]);
    // n() is on the receiving end of the same invocation.
    expect(depsForSelection(ix, 5).incoming.flatMap((group) => group.rows)).toEqual([0]);
  });

  it("buckets a type's outgoing rows by carrying member, the type's own last", () => {
    const byMember = depsForSelection(ix, 1).outgoingByMember;
    expect(byMember.map((group) => group.member)).toEqual([2, 3, undefined]);
    expect(byMember.at(-1)?.rows).toEqual([2]);
  });

  /**
   * A module's imports are declared by the module itself, so every row lands
   * in the memberless bucket. The view keys its "By operation" pane off a
   * member actually being present — this states the fact the pane reads.
   */
  it("leaves a module's rows memberless, so no by-member pane is warranted", () => {
    const moduleDeps = {
      ...model,
      deps: [
        { role: "import", from: 0, to: 4, provenance: "derived", anchor: [0, 3, 3] },
      ],
    } as typeof model;
    const byMember = depsForSelection(buildIndexes(moduleDeps), 0).outgoingByMember;
    expect(byMember.map((group) => group.member)).toEqual([undefined]);
    expect(byMember.some((group) => group.member !== undefined)).toBe(false);
  });
});
