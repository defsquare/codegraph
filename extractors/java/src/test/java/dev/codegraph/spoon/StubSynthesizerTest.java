package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.JsonlWriter;
import dev.codegraph.spoon.model.TraitName;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/**
 * Pass 4 turns "referenced but not declared" into the one degraded node shape
 * METAMODEL.md §6 allows. What it must never do is fabricate: an id the corpus
 * declares, or an id that is not a type at all, gets reported instead of turned
 * into a plausible-looking external class.
 */
class StubSynthesizerTest {

  private static final String DECLARED_TYPE = "java:com.acme.order/OrderService";
  private static final CorpusWhitelist WHITELIST =
      CorpusWhitelist.of(
          List.of(
              "java:com.acme.order",
              DECLARED_TYPE,
              DECLARED_TYPE + ".bill(com.acme.order.Order)"));

  /** The degraded shape: a name, isStub, its external module, and nothing else. */
  @Test
  void aStubIsADegradedClassPlacedInItsExternalModule() {
    List<Entity> stubs = synthesize("java:com.nonexistent.external/MissingLib");
    Entity stub = onlyType(stubs);

    assertEquals("java:com.nonexistent.external/MissingLib", stub.id());
    assertEquals("class", stub.kind());
    assertEquals(
        Set.of(TraitName.TNamed, TraitName.TType, TraitName.TChildOf), Set.copyOf(stub.traits()));
    assertEquals("MissingLib", stub.name());
    assertTrue(stub.stub());
    assertNull(stub.anchor(), "a stub has no source to anchor to");
    assertFalse(
        stub.traits().contains(TraitName.TWithChildren), "a stub type contains nothing we know of");
    assertNull(stub.declaredType());
    assertNull(stub.signature());

    // The module comes with it, or `parent` would dangle and break graph closure.
    Entity module = onlyPackage(stubs);
    assertEquals("java:com.nonexistent.external", module.id());
    assertEquals(module.id(), stub.parent());
    // MM-2: the module declares itself a container; which types are in it is
    // derived from their `parent`, never listed here.
    assertTrue(module.traits().contains(TraitName.TWithChildren));
    assertTrue(module.stub());
  }

  /**
   * The refusal that protects every module-level analysis. Spoon invents FQNs
   * inside the corpus's own packages, so a phantom type may NOT be hung off the
   * real package — that would make a fabrication read as internal and
   * manufacture a module self-dependency out of a class that does not exist.
   */
  @Test
  void aPhantomInACorpusPackageIsNotAttributedToIt() {
    List<Entity> stubs = synthesize("java:com.acme.order/Invoice");
    Entity stub = onlyType(stubs);

    assertEquals(
        1,
        stubs.size(),
        () -> "no module stub may be invented for a package the corpus declares: " + stubs);
    assertNull(
        stub.parent(),
        "an invented type in a corpus package must stay unplaceable, not be attributed to it");
    assertEquals(Set.of(TraitName.TNamed, TraitName.TType), Set.copyOf(stub.traits()));
  }

  /**
   * Identity and containment are different questions (MM-1). A type in the
   * unnamed package still HAS a module in its natural key — the interchange
   * names it by reference, so it must exist as an entity or the type cannot be
   * written at all — but it is still given no PARENT, so nothing folds it into a
   * module-level analysis as though we knew where it lived.
   */
  @Test
  void aTypeWithNoPackageGetsItsModuleButStillNoParent() {
    List<Entity> stubs = synthesize("java:<unnamed>/int");

    assertNull(onlyType(stubs).parent(), "an unplaceable type must not be attributed to a module");
    Entity module = onlyPackage(stubs);
    assertEquals("java:<unnamed>", module.id());
    assertTrue(module.stub(), "the unnamed package of an external type is external too");
  }

  /**
   * The FQNs Spoon invented in noClasspath mode are external until a corpus file
   * declares them — that is what makes them stubs, not their package.
   */
  @Test
  void inventedFullyQualifiedNamesBecomeStubs() {
    List<Entity> stubs = synthesize("java:com.acme.order/Order", "java:com.acme.order/Invoice");
    assertEquals(
        List.of("java:com.acme.order/Invoice", "java:com.acme.order/Order"),
        stubs.stream().map(Entity::id).toList());
    assertTrue(stubs.stream().allMatch(Entity::stub));
    assertEquals(List.of("Invoice", "Order"), stubs.stream().map(Entity::name).toList());
  }

  /** Resolvable on the classpath, still not corpus code: the JDK stubs like anything else. */
  @Test
  void jdkTypesBecomeStubs() {
    assertEquals("String", onlyType(synthesize("java:java.lang/String")).name());
  }

  @Test
  void nestedStubsAreNamedByTheirSimpleName() {
    Entity stub = onlyType(synthesize("java:com.acme.other/Outer.Inner"));
    assertEquals("Inner", stub.name());
    // The enclosing external type is not reified — nothing referenced it — so a
    // nested stub hangs off its module directly. Degraded, but never invented.
    assertEquals("java:com.acme.other", stub.parent());
  }

  @Test
  void stubsAreDeduplicatedAndSorted() {
    Set<String> referenced = new TreeSet<>(List.of("java:z.pkg/Zed", "java:a.pkg/Alpha"));
    referenced.add("java:z.pkg/Zed");

    List<Entity> stubs = new StubSynthesizer().synthesize(referenced, WHITELIST);
    // Each external type brings its module. Determinism is what is being pinned,
    // so compare the sorted ids — Model.sorted decides the emitted order anyway.
    assertEquals(
        List.of("java:a.pkg", "java:a.pkg/Alpha", "java:z.pkg", "java:z.pkg/Zed"),
        stubs.stream().map(Entity::id).sorted().toList());
    assertEquals(4, stubs.size(), "a repeated reference must not duplicate a stub");
  }

  // ---------------------------------------------------- what it refuses to do

  /**
   * A declared id that reaches pass 4 means the entity pass dropped an entity.
   * Fabricating an external type for it would hide the bug and would also lie:
   * the corpus does declare it.
   */
  @Test
  void aDeclaredIdIsReportedNotStubbed() {
    StubSynthesizer synthesizer = new StubSynthesizer();
    List<Entity> stubs = synthesizer.synthesize(Set.of(DECLARED_TYPE), WHITELIST);

    assertTrue(stubs.isEmpty(), "a corpus-declared id is never an external type");
    assertEquals(1, synthesizer.anomalies().size());
    assertTrue(synthesizer.anomalies().get(0).contains(DECLARED_TYPE));
    assertTrue(synthesizer.anomalies().get(0).contains("extraction bug"));
  }

  /**
   * {@code isStub} is contributed by TType and TModule and by nothing else, so a
   * TYPE id and a PACKAGE id both have a representable stub while a MEMBER id has
   * none. A member id is reported, leaving a dangling endpoint for the analyzer's
   * closure property to catch — strictly better than a {@code class} named
   * {@code bill}, which is the fabrication this pass exists to prevent.
   */
  @Test
  void memberIdsAreReportedNotFabricated() {
    StubSynthesizer synthesizer = new StubSynthesizer();
    List<Entity> stubs =
        synthesizer.synthesize(
            new TreeSet<>(
                List.of(
                    "java:com.acme.other/Taxes.apply(double)",
                    "java:com.acme.other/Taxes#Taxes.java:12",
                    "java:com.acme.other/Real")),
            WHITELIST);

    assertEquals(
        List.of("java:com.acme.other", "java:com.acme.other/Real"),
        stubs.stream().map(Entity::id).sorted().toList());
    assertEquals(2, synthesizer.anomalies().size());
    assertTrue(
        synthesizer.anomalies().stream().allMatch(a -> a.contains("not a type or package id")));
  }

  /**
   * The module-level import layer (METAMODEL.md §9) is only first-class if its
   * endpoints exist: {@code import java.util.List} yields an edge to
   * {@code java:java.util}, a package no corpus file declares. It is stubbed as a
   * degraded module — {@code definedIn: []} is what makes it external — so
   * "internal-only view = filter stubs" works for the import graph too.
   */
  @Test
  void externalPackagesBecomeDegradedModuleStubs() {
    StubSynthesizer synthesizer = new StubSynthesizer();
    List<Entity> stubs = synthesizer.synthesize(Set.of("java:java.util"), WHITELIST);

    assertEquals(1, stubs.size());
    Entity pkg = stubs.get(0);
    assertEquals("java:java.util", pkg.id());
    assertEquals("package", pkg.kind());
    assertEquals("java.util", pkg.name(), "a package's name is its full dotted FQN");
    assertEquals(Boolean.TRUE, pkg.isStub());
    assertEquals(List.of(), pkg.definedIn(), "no corpus file declares it — that IS the degradation");
    assertTrue(pkg.traits().contains(TraitName.TWithChildren));
    assertTrue(synthesizer.anomalies().isEmpty(), "a package stub is representable, not an anomaly");
  }

  @Test
  void noReferencesMeansNoStubs() {
    assertTrue(new StubSynthesizer().synthesize(Set.of(), WHITELIST).isEmpty());
    assertTrue(new StubSynthesizer().synthesize(null, WHITELIST).isEmpty());
  }

  // ------------------------------------------------------------- the contract

  /** The degraded shape is only correct if schemas/model.schema.json accepts it. */
  @Test
  void stubsValidateAgainstThePublishedSchema() throws IOException {
    Model model =
        Model.sorted(
            new ExtractorInfo("codegraph-spoon", "0.1.0", Boolean.TRUE),
            "/corpus",
            closedOver(synthesize("java:java.lang/String", "java:com.acme.order/Invoice")),
            List.of());

    String jsonl = new JsonlWriter().toJsonl(model);
    List<String> violations = ExtractorHarness.schemaViolations(jsonl);
    assertTrue(violations.isEmpty(), () -> "schema violations: " + violations);
    assertFalse(jsonl.contains("null"), () -> "a null key reached a stub: " + jsonl);
  }

  /**
   * The corpus package the whitelist declares, which a stubs-only model would
   * otherwise be missing: an entity names its module by reference, so a model
   * that is not closed cannot be written at all.
   */
  private static List<Entity> closedOver(List<Entity> stubs) {
    List<Entity> entities = new java.util.ArrayList<>(stubs);
    entities.add(
        Entity.builder("java:com.acme.order", "package")
            .named("com.acme.order")
            .definedIn(List.of("com/acme/order/OrderService.java"), false)
            .marker(TraitName.TWithChildren)
            .build());
    return entities;
  }

  // ---------------------------------------------------------------- fixtures

  private static List<Entity> synthesize(String... referencedIds) {
    return new StubSynthesizer().synthesize(new TreeSet<>(List.of(referencedIds)), WHITELIST);
  }

  /** The single TYPE stub; synthesis also emits the module stubs types hang off. */
  private static Entity onlyType(List<Entity> entities) {
    List<Entity> types = entities.stream().filter(e -> "class".equals(e.kind())).toList();
    assertEquals(1, types.size(), () -> "expected exactly one type stub, got " + entities);
    return types.get(0);
  }

  private static Entity onlyPackage(List<Entity> entities) {
    List<Entity> packages = entities.stream().filter(e -> "package".equals(e.kind())).toList();
    assertEquals(1, packages.size(), () -> "expected exactly one module stub, got " + entities);
    return packages.get(0);
  }

  private static List<Error> validate(String modelJson) throws IOException {
    Schema schema =
        SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
            .getSchema(Files.readString(schemaFile()), InputFormat.JSON);
    return schema.validate(modelJson, InputFormat.JSON);
  }

  private static Path schemaFile() {
    Path directory = Path.of("").toAbsolutePath();
    while (directory != null) {
      Path candidate = directory.resolve("schemas/model.schema.json");
      if (Files.isRegularFile(candidate)) {
        return candidate;
      }
      directory = directory.getParent();
    }
    throw new AssertionError("schemas/model.schema.json not found above " + Path.of("").toAbsolutePath());
  }
}
