import { describe, expect, it } from "vitest";
import type { Edge, Entity, Model } from "@codegraph/core";

import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { internalOnly } from "../src/views.js";
import {
  DOMAIN_FACTS_ARTIFACT_KIND,
  buildDomainFacts,
  domainFactsToJsonString,
  springProfile,
  type TypeDossier,
} from "../src/index.js";

/**
 * DOMAIN FACTS: the per-type dossier artifact a domain-extraction consumer
 * reads INSTEAD of the raw model — every fact it needs to answer "what does
 * this type do", pre-joined: annotations with their arguments, fields with
 * their declared types, operations with their outgoing invocations, accesses
 * and throw sites, framework roles and injection points, and the module
 * import summary for bounded-context candidates.
 *
 * The corpus below is a small Spring order service, written as a model so
 * every joined fact is exercised in isolation:
 *
 *   enum   OrderStatus
 *   class  Order            status: OrderStatus, total: long,
 *                           MAX_ITEMS: int = 10 (constant)
 *   class  InsufficientStockException
 *   @Service OrderService   placeOrder(Order):
 *                             calls JdbcOrderRepository.save (repository),
 *                             calls stub ApplicationEventPublisher (external),
 *                             writes Order.status, reads Order.total,
 *                             throws InsufficientStockException (corpus)
 *                             and IllegalArgumentException (stub)
 *   @RestController OrderController  create(): @GetMapping (entry point),
 *                             @Autowired OrderService-typed field? no — the
 *                             injection fixture wires the repository interface
 *   interface OrderRepository; @Repository JdbcOrderRepository implements it
 */

const APP = "com.acme.order";
const SPRING_STEREOTYPE = "org.springframework.stereotype";
const SPRING_WEB = "org.springframework.web.bind.annotation";
const SPRING_BEANS = "org.springframework.beans.factory.annotation";
const SPRING_CONTEXT = "org.springframework.context";
const JAVA_LANG = "java.lang";

const MODULE = `java:${APP}`;
const ORDER_STATUS = `java:${APP}/OrderStatus`;
const ORDER = `java:${APP}/Order`;
const STOCK_EX = `java:${APP}/InsufficientStockException`;
const SERVICE = `java:${APP}/OrderService`;
const CONTROLLER = `java:${APP}/OrderController`;
const REPO_IFACE = `java:${APP}/OrderRepository`;
const JDBC_REPO = `java:${APP}/JdbcOrderRepository`;
const PLACE_ORDER = `${SERVICE}.placeOrder(com.acme.order.Order)`;
const CREATE = `${CONTROLLER}.create()`;
const SAVE = `${JDBC_REPO}.save(com.acme.order.Order)`;
const PUBLISHER = `java:${SPRING_CONTEXT}/ApplicationEventPublisher`;
const IAE = `java:${JAVA_LANG}/IllegalArgumentException`;
const SERVICE_ANN = `java:${SPRING_STEREOTYPE}/Service`;
const REPOSITORY_ANN = `java:${SPRING_STEREOTYPE}/Repository`;
const REST_CONTROLLER_ANN = `java:${SPRING_WEB}/RestController`;
const GET_MAPPING_ANN = `java:${SPRING_WEB}/GetMapping`;
const AUTOWIRED_ANN = `java:${SPRING_BEANS}/Autowired`;

function module_(name: string, isStub: boolean, files: string[] = []): Entity {
  return {
    id: `java:${name}`,
    kind: "package",
    traits: ["TNamed", "TModule", "TWithChildren"],
    name,
    definedIn: files,
    isStub,
  } as unknown as Entity;
}

function type_(module: string, name: string, kind: string, isStub = false): Entity {
  return {
    id: `java:${module}/${name}`,
    kind,
    traits: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
    name,
    isStub,
    parent: `java:${module}`,
    anchor: { file: `${name}.java`, span: [1, 40] },
  } as unknown as Entity;
}

function field(owner: string, name: string, declaredType: string, value?: unknown): Entity {
  return {
    id: `${owner}.${name}`,
    kind: "attribute",
    traits: [
      "TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor",
      ...(value === undefined ? [] : ["TWithValue"]),
    ],
    name,
    declaredType,
    parent: owner,
    anchor: { file: "X.java", span: [3, 3] },
    ...(value === undefined ? {} : { value }),
  } as unknown as Entity;
}

function method_(
  owner: string,
  name: string,
  signature: string,
  metrics?: Record<string, number>,
): Entity {
  return {
    id: `${owner}.${signature}`,
    kind: "method",
    traits: [
      "TNamed", "TInvocable", "TWithChildren", "TWithParameters", "TWithLocalVariables",
      "TWithInvocations", "TWithAccesses", "TTypedEntity", "TChildOf", "TSourceAnchor",
      ...(metrics === undefined ? [] : ["TMetrics"]),
    ],
    name,
    signature,
    parameters: [],
    localVariables: [],
    parent: owner,
    anchor: { file: "X.java", span: [10, 21] },
    ...(metrics === undefined ? {} : { metrics }),
  } as unknown as Entity;
}

function edge(kind: string, from: string, to: string, extra: Record<string, unknown> = {}): Edge {
  return {
    edge: kind,
    from,
    to,
    provenance: "declared",
    anchor: { file: "X.java", span: [12, 12] },
    ...extra,
  } as unknown as Edge;
}

function corpus(): Model {
  return {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo",
    entities: [
      module_(APP, false, ["X.java"]),
      module_(SPRING_STEREOTYPE, true),
      module_(SPRING_WEB, true),
      module_(SPRING_BEANS, true),
      module_(SPRING_CONTEXT, true),
      module_(JAVA_LANG, true),
      type_(SPRING_STEREOTYPE, "Service", "annotation", true),
      type_(SPRING_STEREOTYPE, "Repository", "annotation", true),
      type_(SPRING_WEB, "RestController", "annotation", true),
      type_(SPRING_WEB, "GetMapping", "annotation", true),
      type_(SPRING_BEANS, "Autowired", "annotation", true),
      type_(SPRING_CONTEXT, "ApplicationEventPublisher", "interface", true),
      type_(JAVA_LANG, "IllegalArgumentException", "class", true),
      type_(APP, "OrderStatus", "enum"),
      type_(APP, "Order", "class"),
      type_(APP, "InsufficientStockException", "class"),
      type_(APP, "OrderService", "class"),
      type_(APP, "OrderController", "class"),
      type_(APP, "OrderRepository", "interface"),
      type_(APP, "JdbcOrderRepository", "class"),
      field(ORDER, "status", ORDER_STATUS),
      field(ORDER, "total", ORDER),
      field(ORDER, "MAX_ITEMS", ORDER, { k: "number", v: "10" }),
      field(CONTROLLER, "orders", REPO_IFACE),
      method_(SERVICE, "placeOrder", "placeOrder(com.acme.order.Order)", {
        sloc: 12,
        cyclomatic: 3,
      }),
      method_(CONTROLLER, "create", "create()"),
      method_(JDBC_REPO, "save", "save(com.acme.order.Order)"),
    ],
    edges: [
      edge("import", MODULE, `java:${SPRING_STEREOTYPE}`, { provenance: "derived" }),
      edge("interfaceImplementation", JDBC_REPO, REPO_IFACE),
      edge("annotationUse", SERVICE, SERVICE_ANN, { arguments: [] }),
      edge("annotationUse", JDBC_REPO, REPOSITORY_ANN, { arguments: [] }),
      edge("annotationUse", CONTROLLER, REST_CONTROLLER_ANN, { arguments: [] }),
      edge("annotationUse", CREATE, GET_MAPPING_ANN, {
        arguments: [{ name: "value", value: { k: "string", v: "/orders" } }],
      }),
      edge("annotationUse", `${CONTROLLER}.orders`, AUTOWIRED_ANN, { arguments: [] }),
      edge("invocation", PLACE_ORDER, SAVE),
      edge("invocation", PLACE_ORDER, PUBLISHER),
      edge("access", PLACE_ORDER, `${ORDER}.status`, { isRead: false, isWrite: true }),
      edge("access", PLACE_ORDER, `${ORDER}.total`, { isRead: true, isWrite: false }),
      edge("throws", PLACE_ORDER, STOCK_EX, { anchor: { file: "X.java", span: [15, 15] } }),
      edge("throws", PLACE_ORDER, IAE, { anchor: { file: "X.java", span: [18, 18] } }),
      edge("invocation", CREATE, PLACE_ORDER),
    ],
  } as unknown as Model;
}

function graphOf(model: Model = corpus()): ReturnType<typeof buildGraph> {
  return buildGraph(loadModels(model, { sources: ["orders"] }).union);
}

function dossier(types: readonly TypeDossier[], id: string): TypeDossier {
  const found = types.find((type) => type.id === id);
  if (found === undefined) throw new Error(`no dossier for ${id}`);
  return found;
}

describe("buildDomainFacts: the artifact", () => {
  const facts = buildDomainFacts(graphOf(), { framework: springProfile });

  it("states what it is, and for which view", () => {
    expect(facts.kind).toBe(DOMAIN_FACTS_ARTIFACT_KIND);
    expect(facts.generatedBy).toBe("@codegraph/analyzer");
    expect(facts.view.name).toBe("all");
    expect(facts.framework).toBe("spring");
    expect(facts.langs).toEqual(["java"]);
  });

  it("emits one dossier per CORPUS type — stubs get none", () => {
    const ids = facts.types.map((type) => type.id);
    expect(ids).toContain(ORDER);
    expect(ids).toContain(SERVICE);
    expect(ids).toContain(ORDER_STATUS);
    expect(ids).not.toContain(PUBLISHER);
    expect(ids).not.toContain(SERVICE_ANN);
    expect(ids).toEqual([...ids].sort());
  });

  it("is deterministic", () => {
    const again = buildDomainFacts(graphOf(), { framework: springProfile });
    expect(JSON.stringify(again)).toBe(JSON.stringify(facts));
  });
});

describe("buildDomainFacts: fields", () => {
  const facts = buildDomainFacts(graphOf(), { framework: springProfile });
  const order = dossier(facts.types, ORDER);

  it("joins each field to its declared type's name and kind", () => {
    const status = order.fields.find((f) => f.name === "status");
    expect(status?.declaredType).toBe(ORDER_STATUS);
    expect(status?.declaredTypeName).toBe("OrderStatus");
    // The consumer's state-machine candidate: an enum-typed field. The KIND is
    // carried, never interpreted — profiles own kind names, not this artifact.
    expect(status?.declaredTypeKind).toBe("enum");
  });

  it("carries a constant field's written value (§1.6), verbatim", () => {
    const max = order.fields.find((f) => f.name === "MAX_ITEMS");
    expect(max?.value).toEqual({ k: "number", v: "10" });
    const status = order.fields.find((f) => f.name === "status");
    expect(status).not.toHaveProperty("value");
  });
});

describe("buildDomainFacts: operations", () => {
  const facts = buildDomainFacts(graphOf(), { framework: springProfile });
  const service = dossier(facts.types, SERVICE);
  const placeOrder = service.operations.find((op) => op.id === PLACE_ORDER);

  it("joins each invocation to its target's containing type and stereotype", () => {
    const save = placeOrder?.invocations.find((call) => call.to === SAVE);
    expect(save?.targetType).toBe(JDBC_REPO);
    expect(save?.targetStereotype).toBe("repository");
    expect(save?.external).toBe(false);
  });

  it("flags an invocation whose target is external to the corpus", () => {
    const publish = placeOrder?.invocations.find((call) => call.to === PUBLISHER);
    expect(publish?.external).toBe(true);
    expect(publish?.targetStereotype).toBeUndefined();
  });

  it("keeps read and write accesses distinct, joined to the owning type", () => {
    const write = placeOrder?.accesses.find((access) => access.isWrite);
    expect(write?.to).toBe(`${ORDER}.status`);
    expect(write?.ownerType).toBe(ORDER);
    expect(write?.field).toBe("status");
    const read = placeOrder?.accesses.find((access) => access.isRead);
    expect(read?.to).toBe(`${ORDER}.total`);
  });

  it("lists throw sites with their anchors — the evidence a guard clause leaves", () => {
    expect(placeOrder?.throws.map((t) => t.to)).toEqual([STOCK_EX, IAE]);
    const corpusThrow = placeOrder?.throws.find((t) => t.to === STOCK_EX);
    expect(corpusThrow?.external).toBe(false);
    expect(corpusThrow?.anchor.span).toEqual([15, 15]);
    expect(placeOrder?.throws.find((t) => t.to === IAE)?.external).toBe(true);
  });

  it("carries the extractor's measures, unmodified", () => {
    expect(placeOrder?.metrics).toEqual({ sloc: 12, cyclomatic: 3 });
  });

  it("marks framework entry points on the operation the annotation sits on", () => {
    const create = dossier(facts.types, CONTROLLER).operations.find((op) => op.id === CREATE);
    expect(create?.entryPoint).toBe(true);
    expect(create?.annotations.some((a) => a.name === "GetMapping")).toBe(true);
    expect(placeOrder?.entryPoint).toBe(false);
  });
});

describe("buildDomainFacts: framework semantics", () => {
  const facts = buildDomainFacts(graphOf(), { framework: springProfile });

  it("classifies stereotyped types by the framework's own word", () => {
    expect(dossier(facts.types, SERVICE).stereotype).toBe("service");
    expect(dossier(facts.types, JDBC_REPO).stereotype).toBe("repository");
    expect(dossier(facts.types, CONTROLLER).stereotype).toBe("controller");
    expect(dossier(facts.types, ORDER).stereotype).toBeUndefined();
  });

  it("attaches injection points to the consuming type's dossier", () => {
    const controller = dossier(facts.types, CONTROLLER);
    expect(controller.injectionPoints).toHaveLength(1);
    expect(controller.injectionPoints[0]?.declaredType).toBe(REPO_IFACE);
    expect(controller.injectionPoints[0]?.candidates).toEqual([JDBC_REPO]);
  });

  it("says nothing framework-shaped when no profile was given", () => {
    const bare = buildDomainFacts(graphOf());
    expect(bare.framework).toBeUndefined();
    expect(dossier(bare.types, SERVICE).stereotype).toBeUndefined();
    const create = dossier(bare.types, CONTROLLER).operations.find((op) => op.id === CREATE);
    expect(create?.entryPoint).toBe(false);
    // The written annotation is still a fact — only its MEANING needs a profile.
    expect(create?.annotations.some((a) => a.name === "GetMapping")).toBe(true);
    expect(dossier(bare.types, CONTROLLER).injectionPoints).toEqual([]);
  });
});

describe("buildDomainFacts: modules and views", () => {
  it("summarizes each corpus module: its types and its imports", () => {
    const facts = buildDomainFacts(graphOf(), { framework: springProfile });
    const app = facts.modules.find((m) => m.id === MODULE);
    expect(app?.types).toContain(ORDER);
    expect(app?.types).toContain(SERVICE);
    const spring = app?.imports.find((i) => i.to === `java:${SPRING_STEREOTYPE}`);
    expect(spring?.external).toBe(true);
  });

  it("honours the view: internal-only drops every stub-touching fact", () => {
    const facts = buildDomainFacts(graphOf(), {
      framework: springProfile,
      view: internalOnly,
    });
    expect(facts.view.name).toBe("internalOnly");
    const service = dossier(facts.types, SERVICE);
    const placeOrder = service.operations.find((op) => op.id === PLACE_ORDER);
    expect(placeOrder?.invocations.map((call) => call.to)).toEqual([SAVE]);
    expect(placeOrder?.throws.map((t) => t.to)).toEqual([STOCK_EX]);
  });
});

describe("domainFactsToJsonString", () => {
  it("stringifies deterministically, newline-terminated, round-trippable", () => {
    const facts = buildDomainFacts(graphOf(), { framework: springProfile });
    const text = domainFactsToJsonString(facts);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).kind).toBe(DOMAIN_FACTS_ARTIFACT_KIND);
    expect(domainFactsToJsonString(buildDomainFacts(graphOf(), { framework: springProfile }))).toBe(
      text,
    );
  });
});
