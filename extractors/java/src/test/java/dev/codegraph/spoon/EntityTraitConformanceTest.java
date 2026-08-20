package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * PLAN.md §5.1's mapping table, transcribed as literal expected sets and checked
 * against what the extractor actually emitted.
 *
 * <p>The published JSON Schema deliberately stops short of this (PLAN.md §4.5):
 * it enforces the envelope, the entity shape and the trait-key rule, but which
 * kinds exist and which trait compositions each kind licenses is profile
 * knowledge. This test is the extractor-side half of that contract — the half
 * {@link ModelSchemaValidationTest} cannot cover.
 *
 * <p>The rule is {@code required ⊆ traits ⊆ required ∪ optional}, not equality:
 * strict equality breaks the moment a type carries a javadoc comment, and a free
 * subset would hide missing traits. Both bounds are asserted.
 *
 * <p>§5.1's table groups class/interface/enum/record/annotation on one row; the
 * profile (packages/core/src/profiles/java.ts) states the same table more
 * precisely, because an interface never implements and an enum, record or
 * annotation never extends. The finer statement is transcribed here — a trait
 * absent from a kind is profile information, not an omission.
 */
class EntityTraitConformanceTest {

  /** kind → (required, optional). The literal transcription; do not "simplify" it. */
  private static final Map<String, Kind> TABLE =
      Map.ofEntries(
          Map.entry("package", kind(of("TNamed", "TModule", "TWithChildren"), of("TComment"))),
          Map.entry(
              "class",
              kind(
                  of("TNamed", "TType", "TWithInheritances", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          Map.entry(
              "interface",
              kind(
                  of("TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          Map.entry(
              "enum",
              kind(
                  of("TNamed", "TType", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          Map.entry(
              "record",
              kind(
                  of("TNamed", "TType", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          Map.entry(
              "annotation",
              kind(of("TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"), of("TComment"))),
          Map.entry(
              "method",
              kind(
                  of("TNamed", "TInvocable", "TWithChildren", "TWithParameters", "TWithLocalVariables",
                      "TWithInvocations", "TWithAccesses", "TTypedEntity", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          // No TNamed (a constructor has no name of its own) and no
          // TTypedEntity (it has no return type). The id's disambiguator is the signature.
          Map.entry(
              "constructor",
              kind(
                  of("TInvocable", "TWithChildren", "TWithParameters", "TWithLocalVariables",
                      "TWithInvocations", "TWithAccesses", "TChildOf", "TSourceAnchor"),
                  of("TComment"))),
          // Lambdas and anonymous classes: invocable but nameless.
          Map.entry(
              "lambda",
              kind(
                  of("TInvocable", "TWithChildren", "TWithParameters", "TWithLocalVariables",
                      "TWithInvocations", "TWithAccesses", "TChildOf", "TSourceAnchor"),
                  of("TTypedEntity"))),
          Map.entry(
              "attribute",
              kind(of("TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"), of("TComment"))),
          Map.entry(
              "parameter",
              kind(of("TNamed", "TStructural", "TTypedEntity", "TChildOf"), of("TSourceAnchor"))),
          Map.entry(
              "localVariable",
              kind(of("TNamed", "TStructural", "TTypedEntity", "TChildOf"), of("TSourceAnchor"))));

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.jsonl")).succeeded();
  }

  @Test
  void everyEmittedKindIsInTheJavaProfile() {
    Set<String> emitted = new TreeSet<>(kinds());
    emitted.removeAll(TABLE.keySet());
    assertTrue(
        emitted.isEmpty(),
        () -> "kinds emitted that the Java profile does not declare: " + emitted);
  }

  /**
   * The fixture corpus is meant to exercise the whole table. A kind that stops
   * being produced means the corpus lost its coverage — a silent hole in every
   * other test here, so it fails loudly instead.
   */
  @Test
  void theFixtureCorpusExercisesEveryKindInTheTable() {
    Set<String> missing = new TreeSet<>(TABLE.keySet());
    missing.removeAll(kinds());
    assertTrue(
        missing.isEmpty(),
        () -> "the fixtures produced no entity of kind(s): " + missing + "; emitted: " + new TreeSet<>(kinds()));
  }

  @Test
  void everyEntityCarriesExactlyTheTraitsItsKindLicenses() {
    List<String> violations = new ArrayList<>();

    for (JsonNode entity : declaredEntities()) {
      String id = entity.path("id").asText();
      String kindName = entity.path("kind").asText();
      Kind expected = TABLE.get(kindName);
      if (expected == null) {
        continue; // reported by everyEmittedKindIsInTheJavaProfile
      }

      Set<String> traits = new LinkedHashSet<>(ExtractorHarness.traitsOf(entity));

      Set<String> missing = new TreeSet<>(expected.required());
      missing.removeAll(traits);
      if (!missing.isEmpty()) {
        violations.add(kindName + " " + id + " is missing required trait(s) " + missing);
      }

      Set<String> unlicensed = new TreeSet<>(traits);
      unlicensed.removeAll(expected.required());
      unlicensed.removeAll(expected.optional());
      if (!unlicensed.isEmpty()) {
        violations.add(kindName + " " + id + " carries trait(s) its kind does not license: " + unlicensed);
      }
    }

    assertTrue(
        violations.isEmpty(),
        () -> violations.size() + " trait violation(s):\n  " + String.join("\n  ", violations));
  }

  // ------------------------------------------------- the two pinned cases

  /** PLAN.md §5.1: "constructor — no TNamed, no TTypedEntity". */
  @Test
  void aConstructorHasNeitherTNamedNorTTypedEntity() {
    List<JsonNode> constructors = ofKind("constructor");
    assertFalse(constructors.isEmpty(), "the fixtures declare constructors; none was emitted");
    for (JsonNode constructor : constructors) {
      String id = constructor.path("id").asText();
      Set<String> traits = Set.copyOf(ExtractorHarness.traitsOf(constructor));
      assertFalse(traits.contains("TNamed"), () -> "constructor " + id + " must not be TNamed");
      assertFalse(traits.contains("TTypedEntity"), () -> "constructor " + id + " has no return type");
      assertFalse(constructor.has("name"), () -> "constructor " + id + " emitted a name key");
      assertFalse(constructor.has("declaredType"), () -> "constructor " + id + " emitted a declaredType key");
      assertTrue(traits.contains("TInvocable"), () -> "constructor " + id + " must be TInvocable");
    }
  }

  /** PLAN.md §5.1: "lambda / anonymous class — TInvocable WITHOUT TNamed". */
  @Test
  void aLambdaIsInvocableButNameless() {
    List<JsonNode> lambdas = ofKind("lambda");
    assertFalse(lambdas.isEmpty(), "the fixtures contain a lambda; none was emitted");
    for (JsonNode lambda : lambdas) {
      String id = lambda.path("id").asText();
      Set<String> traits = Set.copyOf(ExtractorHarness.traitsOf(lambda));
      assertTrue(traits.contains("TInvocable"), () -> "lambda " + id + " must be TInvocable");
      assertFalse(traits.contains("TNamed"), () -> "lambda " + id + " must not be TNamed");
      assertFalse(lambda.has("name"), () -> "lambda " + id + " emitted a name key");
      assertTrue(lambda.hasNonNull("signature"), () -> "lambda " + id + " has TInvocable but no signature");
    }
  }

  /** The disambiguator of a nameless entity is (file, startLine) — its anchor must agree. */
  @Test
  void aLambdaIsAnchoredWhereItsIdSaysItIs() {
    for (JsonNode lambda : ofKind("lambda")) {
      String id = lambda.path("id").asText();
      JsonNode anchor = lambda.path("anchor");
      assertTrue(anchor.isObject(), () -> "lambda " + id + " has no anchor");
      assertTrue(
          id.endsWith("#" + anchor.path("file").asText() + ":" + anchor.path("span").path(0).asInt()),
          () -> "lambda id " + id + " disagrees with its anchor " + anchor);
    }
  }

  /**
   * TInvocable contributes {@code signature}, and the id's signature disambiguator
   * is the only thing keeping overloads apart. This is the sharpest form of the
   * case: {@code archive(java.util.List)} and
   * {@code archive(com.acme.order.legacy.List)} have IDENTICAL simple parameter
   * names and differ only by package. Under METAMODEL.md §10's illustrative
   * simple-name form both render {@code archive(List)}, collapse into one id, and
   * one method disappears from the model without any error. Hence erased FQNs.
   */
  @Test
  void overloadsCollidingOnSimpleNamesStayDistinctEntities() {
    List<JsonNode> archived =
        ofKind("method").stream()
            .filter(method -> method.path("name").asText().equals("archive"))
            .filter(method -> method.path("parent").asText().equals("java:com.acme.order/OrderService"))
            .toList();

    List<String> ids = archived.stream().map(method -> method.path("id").asText()).sorted().toList();
    assertEquals(
        List.of(
            "java:com.acme.order/OrderService.archive(com.acme.order.legacy.List)",
            "java:com.acme.order/OrderService.archive(java.util.List)"),
        ids,
        () -> "the two archive overloads must be two entities with FQN parameter types: " + ids);

    List<String> signatures =
        archived.stream().map(method -> method.path("signature").asText()).distinct().sorted().toList();
    assertEquals(2, signatures.size(), () -> "the overloads share a signature: " + signatures);
  }

  // ------------------------------------------------------------- fixtures

  /**
   * Stubs are excluded: a stub is a degraded TType node carrying only
   * [TNamed, TType], which is a deliberate exemption from the profile's
   * required-trait lower bound. {@link StubDisciplineTest} owns them.
   */
  private static List<JsonNode> declaredEntities() {
    return run.entities().stream().filter(entity -> !entity.path("isStub").asBoolean()).toList();
  }

  private static List<JsonNode> ofKind(String kindName) {
    return declaredEntities().stream()
        .filter(entity -> entity.path("kind").asText().equals(kindName))
        .toList();
  }

  private static Set<String> kinds() {
    return declaredEntities().stream()
        .map(entity -> entity.path("kind").asText())
        .collect(Collectors.toCollection(TreeSet::new));
  }

  private record Kind(Set<String> required, Set<String> optional) {}

  private static Kind kind(Set<String> required, Set<String> optional) {
    return new Kind(required, optional);
  }

  private static Set<String> of(String... traits) {
    return Set.of(traits);
  }
}
