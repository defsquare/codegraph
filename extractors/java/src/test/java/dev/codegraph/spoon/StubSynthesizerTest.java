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
import dev.codegraph.spoon.model.ModelWriter;
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

  /** The exact degraded shape: two traits, a name, isStub, and nothing else. */
  @Test
  void aStubIsAClassWithTNamedAndTTypeOnly() {
    Entity stub = only(synthesize("java:com.nonexistent.external/MissingLib"));

    assertEquals("java:com.nonexistent.external/MissingLib", stub.id());
    assertEquals("class", stub.kind());
    assertEquals(List.of(TraitName.TNamed, TraitName.TType), stub.traits());
    assertEquals("MissingLib", stub.name());
    assertTrue(stub.stub());
    assertNull(stub.anchor(), "a stub has no source to anchor to");
    assertNull(stub.parent());
    assertNull(stub.children());
    assertNull(stub.declaredType());
    assertNull(stub.signature());
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
    assertEquals("String", only(synthesize("java:java.lang/String")).name());
  }

  @Test
  void nestedStubsAreNamedByTheirSimpleName() {
    Entity stub = only(synthesize("java:com.acme.other/Outer.Inner"));
    assertEquals("Inner", stub.name());
  }

  @Test
  void stubsAreDeduplicatedAndSorted() {
    Set<String> referenced = new TreeSet<>(List.of("java:z.pkg/Zed", "java:a.pkg/Alpha"));
    referenced.add("java:z.pkg/Zed");

    List<Entity> stubs = new StubSynthesizer().synthesize(referenced, WHITELIST);
    assertEquals(List.of("java:a.pkg/Alpha", "java:z.pkg/Zed"), stubs.stream().map(Entity::id).toList());
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
   * {@code isStub} is TType's key and the profile licenses TType for type kinds
   * only, so a package or a member id has no representable stub. Reporting it
   * leaves a dangling endpoint for the analyzer's closure property to catch —
   * strictly better than a {@code class} named {@code util} or {@code bill}.
   */
  @Test
  void nonTypeIdsAreReportedNotFabricated() {
    StubSynthesizer synthesizer = new StubSynthesizer();
    List<Entity> stubs =
        synthesizer.synthesize(
            new TreeSet<>(
                List.of(
                    "java:java.util",
                    "java:com.acme.other/Taxes.apply(double)",
                    "java:com.acme.other/Taxes#Taxes.java:12",
                    "java:com.acme.other/Real")),
            WHITELIST);

    assertEquals(List.of("java:com.acme.other/Real"), stubs.stream().map(Entity::id).toList());
    assertEquals(3, synthesizer.anomalies().size());
    assertTrue(synthesizer.anomalies().stream().allMatch(a -> a.contains("not a type id")));
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
            synthesize("java:java.lang/String", "java:com.acme.order/Invoice"),
            List.of());

    String json = new ModelWriter(true).toJson(model);
    List<Error> errors = validate(json);
    assertTrue(errors.isEmpty(), () -> "schema violations: " + errors);
    assertFalse(json.contains("null"), () -> "a null key reached a stub: " + json);
  }

  // ---------------------------------------------------------------- fixtures

  private static List<Entity> synthesize(String... referencedIds) {
    return new StubSynthesizer().synthesize(new TreeSet<>(List.of(referencedIds)), WHITELIST);
  }

  private static Entity only(List<Entity> entities) {
    assertEquals(1, entities.size(), () -> "expected exactly one entity, got " + entities);
    return entities.get(0);
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
