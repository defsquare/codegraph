import { describe, expect, it } from "vitest";
import { decodeModel, getProfile, selfReferences, unknownReferences, validateModel } from "@codegraph/core";
import { encodeToString } from "../src/model/writer.js";
import { renderKey } from "../src/model/keys.js";
import { crossPackageEdges, hasWorkspaceInstall, packageCycles, selfHost, targetOf } from "./self-hosting.js";

/**
 * CODEGRAPH ON CODEGRAPH (PLAN.md §14.6, the DoD of the phase): the
 * extractor over this repository's own packages, and the architecture rules
 * CLAUDE.md states, restated as graph queries over the result. Needs the
 * workspace installed (the checker binds zod, react, three, vitest through
 * node_modules); skipped otherwise, never faked.
 */
describe.skipIf(!hasWorkspaceInstall())("codegraph over codegraph", () => {
  const { model, stats, seconds } = selfHost();

  it("extracts the workspace in seconds and validates clean against the profile, closed, without self-edges", () => {
    expect(seconds).toBeLessThan(120);
    expect(model.entities.length).toBeGreaterThan(10_000);
    const decoded = decodeModel(encodeToString(model).split("\n"));
    expect(validateModel(decoded, getProfile("ts")!).map((i) => `${i.code} @ ${i.path}`)).toEqual([]);
    expect(unknownReferences(decoded)).toEqual([]);
    expect(selfReferences(decoded)).toEqual([]);
  });

  it("binds every name the corpus declares: no <unresolved> stub, no unresolved workspace import", () => {
    expect(stats.stubs.unresolved).toBe(0);
    expect(model.entities.filter((e) => e.key.module === "<unresolved>")).toEqual([]);
    // Every unresolved import is accounted for: `node:sqlite` (no declarations
    // in @types/node yet) and each frontend's stylesheet side-effect import
    // (`./style.css` — a Vite asset, no TS module behind it). Anything else
    // unresolved is a binding the extractor missed.
    const stubName = new Map(
      model.entities.filter((e) => e.isStub && e.kind === "module").map((e) => [e.key.module, e.name]),
    );
    const accountedFor = model.edges.filter(
      (e) => e.kind === "import" && /^node:sqlite$|\.css$/.test(stubName.get(e.to.module) ?? ""),
    ).length;
    expect(stats.importsUnresolved).toBe(accountedFor);
    expect(stats.duplicateKeys).toEqual([]);
  });

  it("recovers the package boundaries: no dependency cycle crosses a package", () => {
    expect(packageCycles(crossPackageEdges(model))).toEqual([]);
  });

  it("recovers the frontend rule: viz and navigator-ui depend on their model packages for TYPES only", () => {
    const violations: string[] = [];
    for (const { from, to, kind, edge } of crossPackageEdges(model)) {
      const frontend = from === "packages/viz" || from === "packages/navigator-ui";
      const modelPackage = ["packages/city", "packages/navigator", "packages/analyzer", "packages/core"].includes(to);
      if (!frontend || !modelPackage) continue;
      const target = targetOf(model, edge);
      const typeOnly = kind === "import" || (target?.space?.length === 1 && target.space[0] === "type");
      if (!typeOnly) violations.push(`${kind} ${renderKey(edge.from)} -> ${renderKey(edge.to)}`);
    }
    expect(violations).toEqual([]);
  });

  it("recovers the provider boundary: only packages/llm reaches @openrouter/sdk", () => {
    const importers = model.edges
      .filter((e) => e.kind === "import" && e.to.module === "@openrouter%2Fsdk")
      .map((e) => e.from.module)
      .filter((module) => /%2Fsrc%2F/.test(module));
    expect(importers).toEqual(["packages%2Fllm%2Fsrc%2Fopenrouter.ts"]);
  });

  it("recovers the Three.js and React boundaries: viz alone imports three, navigator-ui alone imports react", () => {
    const importersOf = (pkg: string): string[] =>
      [...new Set(model.edges.filter((e) => e.kind === "import" && e.to.module === pkg && /%2Fsrc%2F/.test(e.from.module)).map((e) => e.from.module.split("%2F").slice(0, 2).join("/")))].sort();
    expect(importersOf("three")).toEqual(["packages/viz"]);
    expect(importersOf("react")).toEqual(["packages/navigator-ui"]);
  });
});
