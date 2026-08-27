import { describe, expect, it } from "vitest";
import type { NavNode, NavigatorModel } from "@codegraph/navigator";
import { foldPackages, isGroupId } from "../src/model/fold.js";
import { expandedToReveal, visibleRows } from "../src/model/flatten.js";
import { artifact } from "./fixture.js";

/** A flat corpus: every name is a root module, exactly as Spoon emits packages. */
function flatModules(names: readonly string[], stubs: readonly string[] = []): NavigatorModel {
  const nodes: NavNode[] = names.map((name) => ({
    name,
    kind: "package",
    category: "module",
    isStub: stubs.includes(name),
    children: [],
  }));
  return {
    kind: "codegraph.navigator/1",
    generatedBy: "@codegraph/navigator",
    view: { name: "all", filters: [] },
    corpus: { name: "flat", roots: ["flat"] },
    files: [],
    nodes,
    roots: nodes.map((_, index) => index),
    deps: [],
    diagnostics: { selfDeps: 0, droppedDeps: 0 },
  };
}

describe("package folding", () => {
  it("groups root modules that share a dotted prefix under one node", () => {
    const model = flatModules([
      "jakarta.mail.internet",
      "jakarta.persistence",
      "org.springframework.core",
    ]);
    const fold = foldPackages(model);
    expect(fold.roots).toHaveLength(2);
    const [jakarta, spring] = fold.roots as [number, number];
    expect(isGroupId(model, jakarta)).toBe(true);
    expect(fold.groups[jakarta - model.nodes.length]?.label).toBe("jakarta");
    expect(fold.groups[jakarta - model.nodes.length]?.children).toEqual([0, 1]);
    // Members of a group display their name RELATIVE to the group's prefix.
    expect(fold.labels.get(0)).toBe("mail.internet");
    expect(fold.labels.get(1)).toBe("persistence");
    // A lone chain collapses all the way into the module itself — full name, no group.
    expect(spring).toBe(2);
    expect(isGroupId(model, spring)).toBe(false);
    expect(fold.labels.has(2)).toBe(false);
  });

  it("collapses module-less single-child segments into one group label", () => {
    const model = flatModules([
      "org.apache.fineract.accounting",
      "org.apache.fineract.portfolio",
    ]);
    const fold = foldPackages(model);
    expect(fold.roots).toHaveLength(1);
    const group = fold.groups[(fold.roots[0] as number) - model.nodes.length];
    expect(group?.label).toBe("org.apache.fineract");
    expect(group?.children).toEqual([0, 1]);
    expect(fold.labels.get(0)).toBe("accounting");
    expect(fold.labels.get(1)).toBe("portfolio");
  });

  it("nests a module under the module whose name is its prefix", () => {
    const model = flatModules(["a.b", "a.b.c"]);
    const fold = foldPackages(model);
    expect(fold.roots).toEqual([0]); // a.b, the real module, full name
    expect(fold.labels.has(0)).toBe(false);
    expect(fold.extraChildren.get(0)).toEqual([1]);
    expect(fold.labels.get(1)).toBe("c");
    expect(fold.parentOf.get(1)).toBe(0);
  });

  it("is the identity on a corpus with no shared prefixes", () => {
    const model = artifact();
    const fold = foldPackages(model);
    expect(fold.roots).toEqual([...model.roots]);
    expect(fold.groups).toEqual([]);
    expect(fold.labels.size).toBe(0);
    expect(fold.extraChildren.size).toBe(0);
  });

  it("relabels a DECLARED module child to its name relative to its parent", () => {
    const model = flatModules(["com.acme.order"]);
    const nodes: NavNode[] = [
      { ...(model.nodes[0] as NavNode), children: [1] },
      {
        name: "com.acme.order.adapter",
        kind: "package",
        category: "module",
        isStub: false,
        parent: 0,
        children: [],
      },
    ];
    const fold = foldPackages({ ...model, nodes });
    expect(fold.roots).toEqual([0]);
    expect(fold.labels.get(1)).toBe("adapter");
    // Not a re-parenting: the model's own containment stands untouched.
    expect(fold.extraChildren.size).toBe(0);
    expect(fold.parentOf.size).toBe(0);
  });

  it("marks a group stub-only when every module under it is a stub", () => {
    const model = flatModules(
      ["jakarta.mail", "jakarta.persistence", "com.acme.app", "com.acme.web"],
      ["jakarta.mail", "jakarta.persistence", "com.acme.web"],
    );
    const fold = foldPackages(model);
    const groups = fold.roots
      .filter((id) => isGroupId(model, id))
      .map((id) => fold.groups[id - model.nodes.length]);
    expect(groups.map((group) => [group?.label, group?.allStub])).toEqual([
      ["com.acme", false],
      ["jakarta", true],
    ]);
  });
});

describe("the folded visible-row flattening", () => {
  const model = flatModules(["jakarta.mail.internet", "jakarta.persistence", "zoo"]);
  const fold = foldPackages(model);
  const group = fold.roots[0] as number;

  it("shows collapsed group rows as expandable roots", () => {
    const rows = visibleRows(model, fold, new Set());
    expect(rows.map((row) => row.node)).toEqual([group, 2]);
    expect(rows[0]?.expandable).toBe(true);
  });

  it("expands a group into its member modules, one level deeper", () => {
    const rows = visibleRows(model, fold, new Set([group]));
    expect(rows.map((row) => row.node)).toEqual([group, 0, 1, 2]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 0]);
  });

  it("reveals a grouped module by expanding its group", () => {
    expect([...expandedToReveal(model, fold, new Set(), 1)]).toEqual([group]);
  });

  it("hides a stub-only group when externals are hidden", () => {
    const stubbed = flatModules(["ja.a", "ja.b", "ok.a", "ok.b"], ["ja.a", "ja.b"]);
    const stubbedFold = foldPackages(stubbed);
    const visible = visibleRows(stubbed, stubbedFold, new Set(), { hideExternals: true });
    expect(visible).toHaveLength(1);
    expect(stubbedFold.groups[(visible[0]?.node as number) - stubbed.nodes.length]?.label).toBe("ok");
  });
});
