import { describe, expect, it } from "vitest";
import { AccessEdge, Edge, isSelfReference } from "../src/edges.js";
import { EDGE_KINDS } from "../src/names.js";

const anchor = { file: "OrderService.java", span: [19, 19] as [number, number] };

const base = {
  from: "java:com.acme.order/OrderService.bill(Order)",
  to: "java:com.acme.order/TaxCalculator.apply(double)",
  provenance: "declared",
  anchor,
};

describe("Edge", () => {
  it("round-trips an access edge with isRead/isWrite", () => {
    const input = {
      edge: "access",
      from: "java:com.acme.order/OrderService.bill(Order)",
      to: "java:com.acme.order/Order.total",
      provenance: "declared",
      anchor: { file: "OrderService.java", span: [17, 17] },
      isRead: true,
      isWrite: false,
    };
    const parsed = Edge.parse(input);
    expect(parsed).toEqual(input);
    expect(AccessEdge.parse(input).isWrite).toBe(false);
  });

  it("rejects an access edge missing isRead/isWrite", () => {
    expect(Edge.safeParse({ ...base, edge: "access", isRead: true }).success).toBe(false);
  });

  it("rejects an edge without provenance — it is never defaulted", () => {
    const { provenance: _omitted, ...withoutProvenance } = base;
    expect(Edge.safeParse({ ...withoutProvenance, edge: "invocation" }).success).toBe(false);
  });

  it("rejects an edge without an anchor — every claim carries evidence", () => {
    const { anchor: _omitted, ...withoutAnchor } = base;
    expect(Edge.safeParse({ ...withoutAnchor, edge: "invocation" }).success).toBe(false);
  });

  it("rejects a provenance outside the closed vocabulary", () => {
    expect(Edge.safeParse({ ...base, edge: "invocation", provenance: "guessed" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown edge kind", () => {
    expect(Edge.safeParse({ ...base, edge: "callsMaybe" }).success).toBe(false);
    expect(Edge.safeParse({ ...base }).success).toBe(false);
  });

  it("accepts every kind of the closed edge vocabulary", () => {
    for (const kind of EDGE_KINDS) {
      const extra = kind === "access" ? { isRead: true, isWrite: true } : {};
      const parsed = Edge.parse({ ...base, ...extra, edge: kind });
      expect(parsed.edge).toBe(kind);
    }
  });

  it("keeps candidates and sourceFile optional but preserved when present", () => {
    const minimal = Edge.parse({ ...base, edge: "invocation" });
    expect(minimal).not.toHaveProperty("candidates");
    expect(minimal).not.toHaveProperty("sourceFile");

    const uncertain = Edge.parse({
      ...base,
      edge: "invocation",
      provenance: "dynamic-candidate",
      candidates: [
        "java:com.acme.order/TaxCalculator.apply(double)",
        "java:com.acme.tax/NoopTax.apply(double)",
      ],
      sourceFile: "OrderService.java",
    });
    expect(uncertain.candidates).toHaveLength(2);
    expect(uncertain.sourceFile).toBe("OrderService.java");
  });

  it("parses self-references but flags them for the graph property suite", () => {
    const loop = Edge.parse({ ...base, edge: "invocation", to: base.from });
    expect(loop.from).toBe(loop.to);
    expect(isSelfReference(loop)).toBe(true);
    expect(isSelfReference(Edge.parse({ ...base, edge: "invocation" }))).toBe(false);
  });

  it("parses the worked example invocation edge from METAMODEL §10", () => {
    const parsed = Edge.parse({
      edge: "invocation",
      from: "java:com.acme.order/OrderService.bill(Order)",
      to: "java:com.acme.order/TaxCalculator.apply(double)",
      provenance: "declared",
      anchor: { file: "OrderService.java", span: [19, 19] },
    });
    expect(parsed.edge).toBe("invocation");
    expect(parsed.provenance).toBe("declared");
    expect(parsed.anchor.span).toEqual([19, 19]);
  });
});
