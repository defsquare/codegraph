import { describe, expect, it } from "vitest";
import type { Edge, Entity, Model } from "@codegraph/core";

import { buildGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import {
  FRAMEWORK_ROLES,
  deriveFrameworkWiring,
  springProfile,
  validateFrameworkProfile,
  type FrameworkProfile,
} from "../src/index.js";

/**
 * FRAMEWORK SEMANTICS (M10d, METAMODEL §9.1). The corpus below is a Spring app
 * in miniature, written as a model rather than as Java so every rule can be
 * exercised in isolation:
 *
 *   @Service   ClinicServiceImpl implements ClinicService
 *   @Service   BackupServiceImpl implements ClinicService   (@Primary)
 *   @Repository JdbcOwnerRepository implements OwnerRepository
 *   @Controller OwnerController        <- @Autowired ClinicService     (2 impls, one @Primary)
 *                                      <- sole-constructor OwnerRepository (1 impl)
 *                                      <- @Autowired @Qualifier("backupServiceImpl") ClinicService
 *   plain      Helper                  <- @Autowired ClinicService  (NOT stereotyped: not wired)
 *
 * Every Spring type is a STUB, exactly as in a real corpus whose framework jars
 * are absent — which is the case the matching rule has to survive.
 */

const SPRING_STEREOTYPE = "org.springframework.stereotype";
const SPRING_BEANS = "org.springframework.beans.factory.annotation";
const SPRING_CONTEXT = "org.springframework.context.annotation";
const APP = "com.acme.clinic";

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
    anchor: { file: `${name}.java`, span: [1, 20] },
  } as unknown as Entity;
}

function field(owner: string, name: string, declaredType: string): Entity {
  return {
    id: `${owner}.${name}`,
    kind: "attribute",
    traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
    name,
    declaredType,
    parent: owner,
    anchor: { file: "X.java", span: [3, 3] },
  } as unknown as Entity;
}

function constructor_(owner: string, signature: string, parameters: string[]): Entity {
  return {
    id: `${owner}.<init>${signature}`,
    kind: "constructor",
    traits: [
      "TInvocable", "TWithChildren", "TWithParameters", "TWithLocalVariables",
      "TWithInvocations", "TWithAccesses", "TChildOf", "TSourceAnchor",
    ],
    signature: `<init>${signature}`,
    parameters,
    localVariables: [],
    parent: owner,
    anchor: { file: "X.java", span: [5, 8] },
  } as unknown as Entity;
}

function parameter(owner: string, name: string, declaredType: string): Entity {
  return {
    id: `${owner}#param:${name}`,
    kind: "parameter",
    traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
    name,
    declaredType,
    parent: owner,
  } as unknown as Entity;
}

function annotationUse(from: string, to: string, args: unknown[] = []): Edge {
  return {
    edge: "annotationUse",
    from,
    to,
    provenance: "declared",
    anchor: { file: "X.java", span: [1, 1] },
    arguments: args,
  } as unknown as Edge;
}

function implementsEdge(from: string, to: string): Edge {
  return {
    edge: "interfaceImplementation",
    from,
    to,
    provenance: "declared",
    anchor: { file: "X.java", span: [1, 1] },
  } as unknown as Edge;
}

const CLINIC = `java:${APP}/ClinicService`;
const CLINIC_IMPL = `java:${APP}/ClinicServiceImpl`;
const BACKUP_IMPL = `java:${APP}/BackupServiceImpl`;
const OWNER_REPO = `java:${APP}/OwnerRepository`;
const JDBC_REPO = `java:${APP}/JdbcOwnerRepository`;
const JPA_REPO = `java:${APP}/JpaOwnerRepository`;
const CONTROLLER = `java:${APP}/OwnerController`;
const HELPER = `java:${APP}/Helper`;
const SERVICE_ANN = `java:${SPRING_STEREOTYPE}/Service`;
const REPOSITORY_ANN = `java:${SPRING_STEREOTYPE}/Repository`;
const CONTROLLER_ANN = `java:${SPRING_STEREOTYPE}/Controller`;
const AUTOWIRED_ANN = `java:${SPRING_BEANS}/Autowired`;
const QUALIFIER_ANN = `java:${SPRING_BEANS}/Qualifier`;
const PRIMARY_ANN = `java:${SPRING_CONTEXT}/Primary`;

function springCorpus(): Model {
  const ctor = `${CONTROLLER}.<init>(OwnerRepository)`;
  return {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0" },
    root: "demo",
    entities: [
      module_(APP, false, ["X.java"]),
      module_(SPRING_STEREOTYPE, true),
      module_(SPRING_BEANS, true),
      module_(SPRING_CONTEXT, true),
      type_(SPRING_STEREOTYPE, "Service", "annotation", true),
      type_(SPRING_STEREOTYPE, "Repository", "annotation", true),
      type_(SPRING_STEREOTYPE, "Controller", "annotation", true),
      type_(SPRING_BEANS, "Autowired", "annotation", true),
      type_(SPRING_BEANS, "Qualifier", "annotation", true),
      type_(SPRING_CONTEXT, "Primary", "annotation", true),
      type_(APP, "ClinicService", "interface"),
      type_(APP, "OwnerRepository", "interface"),
      type_(APP, "ClinicServiceImpl", "class"),
      type_(APP, "BackupServiceImpl", "class"),
      type_(APP, "JdbcOwnerRepository", "class"),
      type_(APP, "JpaOwnerRepository", "class"),
      type_(APP, "OwnerController", "class"),
      type_(APP, "Helper", "class"),
      field(CONTROLLER, "clinic", CLINIC),
      field(CONTROLLER, "backup", CLINIC),
      field(HELPER, "clinic", CLINIC),
      constructor_(CONTROLLER, "(OwnerRepository)", [`${ctor}#param:repository`]),
      parameter(ctor, "repository", OWNER_REPO),
    ],
    edges: [
      implementsEdge(CLINIC_IMPL, CLINIC),
      implementsEdge(BACKUP_IMPL, CLINIC),
      implementsEdge(JDBC_REPO, OWNER_REPO),
      implementsEdge(JPA_REPO, OWNER_REPO),
      annotationUse(CLINIC_IMPL, SERVICE_ANN),
      annotationUse(BACKUP_IMPL, SERVICE_ANN),
      annotationUse(BACKUP_IMPL, PRIMARY_ANN),
      annotationUse(JDBC_REPO, REPOSITORY_ANN),
      annotationUse(JPA_REPO, REPOSITORY_ANN),
      annotationUse(CONTROLLER, CONTROLLER_ANN),
      annotationUse(`${CONTROLLER}.clinic`, AUTOWIRED_ANN),
      annotationUse(`${CONTROLLER}.backup`, AUTOWIRED_ANN),
      annotationUse(`${CONTROLLER}.backup`, QUALIFIER_ANN, [
        { name: "value", value: { k: "string", v: "backupServiceImpl" } },
      ]),
      // Helper is NOT stereotyped: an annotation on a type the container never
      // instantiates wires nothing.
      annotationUse(`${HELPER}.clinic`, AUTOWIRED_ANN),
    ],
  } as unknown as Model;
}

function springGraph(): ReturnType<typeof buildGraph> {
  return buildGraph(loadModels(springCorpus(), { sources: ["spring"] }).union);
}

describe("the framework profile is data", () => {
  it("ships a well-formed Spring table", () => {
    expect(validateFrameworkProfile(springProfile)).toEqual([]);
    expect(springProfile.annotations.length).toBeGreaterThan(20);
  });

  /**
   * The profile-robustness test, one level up (§5's rule for languages): a
   * framework nobody implemented must be describable, and must validate.
   */
  it("accepts a framework that exists only as a table", () => {
    const micronaut: FrameworkProfile = {
      framework: "micronaut",
      implicitSoleConstructorInjection: true,
      annotations: [
        { name: "Singleton", module: "jakarta.inject", role: "stereotype", stereotype: "service" },
        { name: "Inject", module: "jakarta.inject", role: "injection-point" },
        { name: "Get", module: "io.micronaut.http.annotation", role: "entry-point" },
      ],
      notes: [],
    };
    expect(validateFrameworkProfile(micronaut)).toEqual([]);
  });

  it("refuses a table that could not classify anything", () => {
    const broken: FrameworkProfile = {
      framework: "",
      implicitSoleConstructorInjection: false,
      annotations: [
        { name: "Service", module: "x", role: "stereotype" },
        { name: "Service", module: "x", role: "injection-point" },
        { name: "Inject", module: "x", role: "injection-point", stereotype: "service" },
      ],
      notes: [],
    };
    const issues = validateFrameworkProfile(broken);
    expect(issues).toContain("framework id must be non-empty");
    expect(issues.some((issue) => issue.includes("must name the architectural role"))).toBe(true);
    expect(issues.some((issue) => issue.includes("only a stereotype carries"))).toBe(true);
    expect(issues.some((issue) => issue.includes("declared twice"))).toBe(true);
  });

  it("keeps the role vocabulary closed", () => {
    expect([...FRAMEWORK_ROLES]).toEqual([
      "stereotype",
      "injection-point",
      "entry-point",
      "qualifier",
      "primary",
    ]);
  });
});

describe("deriveFrameworkWiring: roles", () => {
  const wiring = deriveFrameworkWiring(springGraph(), springProfile);

  it("classifies every stereotyped type, by the annotation that says so", () => {
    const stereotypes = new Map(
      wiring.roles.filter((role) => role.role === "stereotype").map((role) => [role.id, role.stereotype]),
    );
    expect(stereotypes.get(CLINIC_IMPL)).toBe("service");
    expect(stereotypes.get(BACKUP_IMPL)).toBe("service");
    expect(stereotypes.get(JDBC_REPO)).toBe("repository");
    expect(stereotypes.get(CONTROLLER)).toBe("controller");
    // A plain class is not a bean, and nothing here guesses one from its name.
    expect(stereotypes.has(HELPER)).toBe(false);
    expect(stereotypes.has(CLINIC)).toBe(false);
  });

  it("matches on an annotation that is a STUB — the normal case", () => {
    const graph = springGraph();
    expect(graph.isStub(SERVICE_ANN)).toBe(true);
    expect(wiring.roles.some((role) => role.annotation === SERVICE_ANN)).toBe(true);
  });

  it("carries the annotation as evidence for every assignment", () => {
    for (const role of wiring.roles) expect(role.annotation).toMatch(/^java:/);
  });
});

describe("deriveFrameworkWiring: injection points", () => {
  const wiring = deriveFrameworkWiring(springGraph(), springProfile);
  const point = (id: string) => wiring.injectionPoints.find((candidate) => candidate.id === id);

  it("lists every corpus implementation when nothing narrows the choice", () => {
    // Two repositories implement OwnerRepository and neither is @Primary: the
    // container decides at runtime, so the model states both, sorted, and
    // claims nothing about which one wins.
    const repository = wiring.injectionPoints.find((p) => p.via === "sole-constructor");
    expect(repository?.declaredType).toBe(OWNER_REPO);
    expect(repository?.candidates).toEqual([JDBC_REPO, JPA_REPO]);
    expect(repository?.note).toBeUndefined();
  });

  it("narrows to the @Primary bean, and SAYS how many it narrowed from", () => {
    const clinic = point(`${CONTROLLER}.clinic`);
    expect(clinic?.via).toBe("annotation");
    expect(clinic?.consumer).toBe(CONTROLLER);
    // Spring's own rule: with two candidates and one @Primary, that one wins.
    expect(clinic?.candidates).toEqual([BACKUP_IMPL]);
    // ...and the alternative is not silently dropped.
    expect(clinic?.note).toBe("narrowed by @Primary from 2 corpus implementations");
  });

  it("narrows on @Qualifier by the bean's name — an exact match, not a guess", () => {
    const backup = point(`${CONTROLLER}.backup`);
    expect(backup?.qualifier).toBe("backupServiceImpl");
    expect(backup?.candidates).toEqual([BACKUP_IMPL]);
    expect(backup?.note).toBe('narrowed by @Qualifier("backupServiceImpl") from 2 corpus implementations');
  });

  it("ignores an injection point on a type the container never instantiates", () => {
    expect(point(`${HELPER}.clinic`)).toBeUndefined();
  });

  it("says WHY a candidate set is empty rather than leaving it bare", () => {
    const graph = buildGraph(
      loadModels(
        {
          ...springCorpus(),
          // Same corpus, minus every implementation: a Spring Data repository,
          // implemented by the container at runtime.
          edges: springCorpus().edges.filter((edge) => edge.edge !== "interfaceImplementation"),
        } as Model,
        { sources: ["spring"] },
      ).union,
    );
    const bare = deriveFrameworkWiring(graph, springProfile);
    const clinic = bare.injectionPoints.find((p) => p.id === `${CONTROLLER}.clinic`);
    expect(clinic?.candidates).toEqual([]);
    expect(clinic?.note).toMatch(/no corpus type implements it/);
    expect(bare.diagnostics.unimplemented).toBeGreaterThan(0);
    expect(bare.edges).toEqual([]);
  });
});

describe("deriveFrameworkWiring: the edges it derives", () => {
  const graph = springGraph();
  const wiring = deriveFrameworkWiring(graph, springProfile);

  it("emits one dynamic-candidate edge per candidate, each carrying the whole set", () => {
    const fromController = wiring.edges.filter((edge) => edge.from === CONTROLLER);
    expect(fromController.map((edge) => edge.to).sort()).toEqual(
      [BACKUP_IMPL, BACKUP_IMPL, JDBC_REPO, JPA_REPO].sort(),
    );
    for (const edge of fromController) {
      // §1.3 verbatim: dispatch not statically resolvable, targets are guesses.
      expect(edge.provenance).toBe("dynamic-candidate");
      expect(edge.candidates).toContain(edge.to);
      expect(edge.anchor.file.length).toBeGreaterThan(0);
    }
  });

  /**
   * THE DoD PROPERTY: inference adds nothing to the facts. The pass returns
   * edges; it does not put them anywhere, so a facts-only view of the graph is
   * identical whether or not anyone ran it.
   */
  it("leaves the model untouched — the declared view is unchanged by the pass", () => {
    const before = JSON.stringify(graph.edges.filter((edge) => edge.provenance === "declared"));
    deriveFrameworkWiring(graph, springProfile);
    const after = JSON.stringify(graph.edges.filter((edge) => edge.provenance === "declared"));
    expect(after).toBe(before);
    expect(graph.edges.every((edge) => edge.provenance === "declared")).toBe(true);
  });

  it("never derives a self-edge, which the metamodel cannot express", () => {
    for (const edge of wiring.edges) expect(edge.from).not.toBe(edge.to);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(deriveFrameworkWiring(springGraph(), springProfile))).toBe(
      JSON.stringify(deriveFrameworkWiring(springGraph(), springProfile)),
    );
  });
});
