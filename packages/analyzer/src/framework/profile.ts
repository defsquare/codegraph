/**
 * FRAMEWORK PROFILES (METAMODEL.md §9.1) — §5's rule, one level up.
 *
 * What an annotation MEANS (`@Autowired` marks an injection point, `@Service` a
 * stereotype, `@Qualifier` narrows candidates) is a declarative table, exactly
 * as a language profile is: specifiable without being implemented, extensible
 * to CDI or Micronaut by adding rows rather than code.
 *
 * WHY IT LIVES IN THE ANALYZER, not the extractor. The extractor already emits
 * the facts — an `annotationUse` edge per written annotation, with its
 * arguments (§1.6) — and stays framework-blind. What those facts MEAN is an
 * inference, so it belongs on the derived side, and every edge it produces is
 * `dynamic-candidate` and in-memory only (invariant 4 applied to inference).
 *
 * MATCHING READS NAME + MODULE, NEVER A PARSED ID (invariant 7). An annotation
 * type is matched by its `TNamed` name and the module its containment chain
 * ends in — and the target is nearly always a STUB, because a corpus whose
 * framework jars are absent declares none of these types. That is the normal
 * case, not a degraded one: `@Service` on a petclinic class points at a stub
 * `org.springframework.stereotype/Service`, which carries exactly the two
 * things this table needs.
 */

/**
 * What an annotation says about the entity carrying it.
 *
 * `primary` is the one role PLAN §12.4's list did not name: `@Primary` narrows
 * a candidate set by PRESENCE (it marks the producer, not the injection point),
 * which is neither a qualifier nor a stereotype. Adding it is a row, not code —
 * which is the property the table exists to have.
 */
export const FRAMEWORK_ROLES = [
  "stereotype",
  "injection-point",
  "entry-point",
  "qualifier",
  "primary",
] as const;
export type FrameworkRole = (typeof FRAMEWORK_ROLES)[number];

export interface AnnotationSpec {
  /** The annotation type's simple name, e.g. `Autowired`. */
  readonly name: string;
  /** The module (package) that declares it — matched, never parsed out of an id. */
  readonly module: string;
  readonly role: FrameworkRole;
  /**
   * For `stereotype` only: the architectural role it names (`service`,
   * `repository`, `controller`, `configuration`, `component`). This is the
   * label a report prints and the city colors by — the framework's own word
   * for what the type is FOR, which no structural metric can recover.
   */
  readonly stereotype?: string;
}

export interface FrameworkProfile {
  /** Identifier of the framework this table describes. */
  readonly framework: string;
  readonly annotations: readonly AnnotationSpec[];
  /**
   * Spring 4.3+ and CDI alike: the SOLE constructor of a stereotyped class is
   * an injection point with no annotation on it. Stated as data because it is
   * a framework rule, not a fact about the source — and because a framework
   * without it (an older Spring, a container requiring `@Inject`) is described
   * by flipping this field rather than by branching in code.
   */
  readonly implicitSoleConstructorInjection: boolean;
  readonly notes: readonly string[];
}

/**
 * Spring, including the Jakarta/JSR-330 annotations Spring honours. Rows only —
 * nothing here is executable, and a reader can check every line against the
 * framework's own documentation.
 */
export const springProfile: FrameworkProfile = {
  framework: "spring",
  implicitSoleConstructorInjection: true,
  annotations: [
    // Stereotypes: what the type IS, in the framework's vocabulary.
    { name: "Component", module: "org.springframework.stereotype", role: "stereotype", stereotype: "component" },
    { name: "Service", module: "org.springframework.stereotype", role: "stereotype", stereotype: "service" },
    { name: "Repository", module: "org.springframework.stereotype", role: "stereotype", stereotype: "repository" },
    { name: "Controller", module: "org.springframework.stereotype", role: "stereotype", stereotype: "controller" },
    {
      name: "RestController",
      module: "org.springframework.web.bind.annotation",
      role: "stereotype",
      stereotype: "controller",
    },
    {
      name: "Configuration",
      module: "org.springframework.context.annotation",
      role: "stereotype",
      stereotype: "configuration",
    },
    {
      name: "SpringBootApplication",
      module: "org.springframework.boot.autoconfigure",
      role: "stereotype",
      stereotype: "configuration",
    },
    { name: "ControllerAdvice", module: "org.springframework.web.bind.annotation", role: "stereotype", stereotype: "controller" },

    // Injection points: where the container hands an instance in.
    { name: "Autowired", module: "org.springframework.beans.factory.annotation", role: "injection-point" },
    { name: "Inject", module: "javax.inject", role: "injection-point" },
    { name: "Inject", module: "jakarta.inject", role: "injection-point" },
    { name: "Resource", module: "javax.annotation", role: "injection-point" },
    { name: "Resource", module: "jakarta.annotation", role: "injection-point" },

    // Entry points: what calls INTO the corpus, with no caller inside it. The
    // reason a controller method looks dead to a static call graph.
    { name: "RequestMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "GetMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "PostMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "PutMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "DeleteMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "PatchMapping", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "EventListener", module: "org.springframework.context.event", role: "entry-point" },
    { name: "Scheduled", module: "org.springframework.scheduling.annotation", role: "entry-point" },
    { name: "Bean", module: "org.springframework.context.annotation", role: "entry-point" },
    { name: "InitBinder", module: "org.springframework.web.bind.annotation", role: "entry-point" },
    { name: "ModelAttribute", module: "org.springframework.web.bind.annotation", role: "entry-point" },

    // Narrowing.
    { name: "Qualifier", module: "org.springframework.beans.factory.annotation", role: "qualifier" },
    { name: "Named", module: "javax.inject", role: "qualifier" },
    { name: "Named", module: "jakarta.inject", role: "qualifier" },
    { name: "Primary", module: "org.springframework.context.annotation", role: "primary" },
  ],
  notes: [
    "Matching is (simple name, declaring module) — never a parsed id. The annotation entity is normally a STUB, because a corpus's framework jars are absent; a stub still carries TNamed and a module through TChildOf, which is all this table reads.",
    "A meta-annotated stereotype (a custom `@MyService` itself annotated `@Service`) is NOT followed: doing so would need the annotation type's own declaration, which is exactly what a stub does not have. Such a type classifies as unstereotyped, honestly, rather than by guessing from the name.",
    "XML bean definitions, `@ComponentScan` filters, `FactoryBean`s and programmatic registration are invisible here. The derived wiring is a lower bound on what the container actually wires — which is why every edge it produces is `dynamic-candidate`.",
    "Spring Data repositories are interfaces the container IMPLEMENTS AT RUNTIME. An injection of one lists no candidates, and that empty set is a fact about the corpus: the implementation is not in the source at all.",
  ],
};

/** Profiles by framework id — the registry a caller selects from. */
export const FRAMEWORK_PROFILES: Readonly<Record<string, FrameworkProfile>> = {
  spring: springProfile,
};

/** Every issue that makes a profile unusable; empty means it is well-formed. */
export function validateFrameworkProfile(profile: FrameworkProfile): readonly string[] {
  const issues: string[] = [];
  if (profile.framework.trim() === "") issues.push("framework id must be non-empty");
  const seen = new Set<string>();
  for (const spec of profile.annotations) {
    const key = `${spec.module}/${spec.name}`;
    if (spec.name.trim() === "") issues.push("an annotation spec has no name");
    if (spec.module.trim() === "") issues.push(`${key}: an annotation spec has no module`);
    if (!FRAMEWORK_ROLES.includes(spec.role)) issues.push(`${key}: unknown role ${spec.role}`);
    // A stereotype without its label would classify a type as "some role".
    if (spec.role === "stereotype" && (spec.stereotype ?? "").trim() === "") {
      issues.push(`${key}: a stereotype must name the architectural role it assigns`);
    }
    if (spec.role !== "stereotype" && spec.stereotype !== undefined) {
      issues.push(`${key}: only a stereotype carries a stereotype label`);
    }
    if (seen.has(key)) issues.push(`${key}: declared twice`);
    seen.add(key);
  }
  return issues;
}
