package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Two entities that DO NOT EXIST, and the edges that used to claim they did.
 * Both were found by running the extractor over a real corpus (commons-lang,
 * 263 files); the fixtures had arrays and an anonymous class but never
 * exercised a member of either, so both bugs were invisible here.
 *
 * <ol>
 *   <li><b>An array type is not an entity.</b> {@code xs.length} and
 *       {@code int[]::new} declare their member on {@code int[]} /
 *       {@code Money[]}. {@link EntityIds#forTypeReference} unwraps an array to
 *       its component (deliberately — the component IS the dependency), so
 *       folding the member up named the component and stated a fact the source
 *       never wrote: an access on {@code java.lang.String}, and a stub CLASS
 *       named {@code boolean}. On commons-lang that was 8 primitive stub classes
 *       with a fan-in of 44-88 each — the exact phantom PLAN.md §5.2 forbids by
 *       name, arriving through the one path that never asked the primitive
 *       question.
 *   <li><b>An anonymous class has ONE id.</b> Pass 2 declares it as
 *       {@code Outer#file:line}; a type REFERENCE to it carries Spoon's
 *       {@code Outer$N}, which renders {@code java:pkg/Outer.N}. Left alone the
 *       same class got two ids, and the second — never declared, so never
 *       whitelisted — was synthesized into a stub bearing the corpus's own
 *       package. That is invariant 6's failure mode arriving from the inside.
 * </ol>
 */
class ArrayAndAnonymousIdentityTest {

  /** No profile in any language makes a primitive an entity (PLAN.md §5.2). */
  private static final Set<String> PRIMITIVE_IDS =
      Set.of("boolean", "byte", "char", "double", "float", "int", "long", "short", "void")
          .stream()
          .map(name -> EntityIds.PREFIX + EntityIds.UNNAMED_PACKAGE + "/" + name)
          .collect(Collectors.toUnmodifiableSet());

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;
  private static Map<String, JsonNode> byId;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.jsonl")).succeeded();
    byId = new TreeMap<>();
    for (JsonNode entity : run.entities()) {
      byId.put(entity.path("id").asText(), entity);
    }
  }

  // ------------------------------------------------------------- primitives

  @Test
  void noEntityIsAPrimitive() {
    List<String> found = byId.keySet().stream().filter(PRIMITIVE_IDS::contains).toList();
    assertTrue(
        found.isEmpty(),
        () ->
            "primitive stub classes reached the model: "
                + found
                + ". A primitive is not an entity; a phantom class named `int` with a large "
                + "fan-in distorts every coupling metric the analyzer computes (PLAN.md §5.2).");
  }

  @Test
  void noEdgePointsAtAPrimitive() {
    List<String> offenders = new ArrayList<>();
    for (JsonNode edge : run.edges()) {
      if (PRIMITIVE_IDS.contains(edge.path("to").asText())
          || PRIMITIVE_IDS.contains(edge.path("from").asText())) {
        offenders.add(edge.path("edge").asText() + " " + edge.path("from").asText()
            + " -> " + edge.path("to").asText() + " @ " + anchorOf(edge));
      }
    }
    assertTrue(offenders.isEmpty(), () -> "edges to/from a primitive:\n  " + String.join("\n  ", offenders));
  }

  @Test
  void noDeclaredTypeIsAPrimitive() {
    List<String> offenders =
        run.entities().stream()
            .filter(entity -> PRIMITIVE_IDS.contains(entity.path("declaredType").asText()))
            .map(entity -> entity.path("id").asText())
            .toList();
    assertTrue(
        offenders.isEmpty(),
        () ->
            "declaredType names a primitive on: "
                + offenders
                + ". `int[]` is not primitive but its id IS `java:<unnamed>/int` — the test must "
                + "be applied to the type the id names, not to the reference.");
  }

  // ------------------------------------------------- arrays own their members

  /**
   * {@code counts.length} reads the field {@code counts}, which the corpus
   * declares — that fact stays. What must not appear is a second fact claiming
   * {@code Batch.priced()} touches a member of {@code Money}, which is what
   * folding {@code Money[].length} up to its component produced.
   */
  @Test
  void anArrayMemberIsNotAttributedToTheComponentType() {
    String priced = "java:com.acme.order/Batch.priced()";
    assertTrue(byId.containsKey(priced), () -> priced + " is declared by the fixtures");

    List<JsonNode> from = edgesFrom(priced);
    assertTrue(
        from.stream()
            .anyMatch(
                edge ->
                    "access".equals(edge.path("edge").asText())
                        && "java:com.acme.order/Batch.prices".equals(edge.path("to").asText())),
        () -> "the real fact — priced() reads the field `prices` — was lost: " + describe(from));
    assertTrue(
        from.stream().noneMatch(edge -> "java:com.acme.order/Money".equals(edge.path("to").asText())),
        () ->
            "priced() claims a dependency on Money through `prices.length`. `length` belongs to "
                + "Money[], not to Money, and Money[] is not an entity: "
                + describe(from));
  }

  /** {@code int[]::new} declares its constructor on the array type; nothing may receive it. */
  @Test
  void anArrayConstructorReferenceStatesNoMemberFact() {
    String allocator = "java:com.acme.order/Batch.allocator()";
    assertTrue(byId.containsKey(allocator), () -> allocator + " is declared by the fixtures");
    List<JsonNode> invocations =
        edgesFrom(allocator).stream()
            .filter(edge -> "invocation".equals(edge.path("edge").asText()))
            .toList();
    assertTrue(
        invocations.isEmpty(),
        () ->
            "`int[]::new` produced an invocation. Its declaring type is int[], which is not an "
                + "entity, and its component is a primitive: " + describe(invocations));
  }

  // ------------------------------------------- an anonymous class has one id

  @Test
  void noStubIsSpoonsNameForAnAnonymousClass() {
    List<String> numbered =
        byId.entrySet().stream()
            .filter(entry -> entry.getValue().path("isStub").asBoolean())
            .map(Map.Entry::getKey)
            .filter(id -> EntityIds.typeSimpleName(id).chars().allMatch(Character::isDigit))
            .toList();
    assertTrue(
        numbered.isEmpty(),
        () ->
            "stubs named after Spoon's anonymous-class numbering: "
                + numbered
                + ". Those classes ARE declared by the corpus, under their `#file:line` id; a "
                + "second id for them launders a declared class into a stub carrying the "
                + "corpus's own package (CLAUDE.md invariant 6).");
  }

  /**
   * The anonymous {@code Priceable} in {@code Batch.running()} reads its own
   * field and calls its own method, so edges must NAME it. They must name the id
   * pass 2 declared.
   */
  @Test
  void edgesIntoAnAnonymousClassUseTheIdPassTwoDeclared() {
    List<String> declared =
        byId.keySet().stream().filter(id -> id.startsWith("java:com.acme.order/Batch#")).sorted().toList();
    assertFalse(
        declared.isEmpty(),
        () -> "Batch declares an anonymous Priceable; no entity carries its `#file:line` id");

    String anonymous =
        declared.stream()
            .filter(id -> "lambda".equals(byId.get(id).path("kind").asText()))
            .findFirst()
            .orElseThrow(() -> new AssertionError("no anonymous class entity under Batch: " + declared));

    // Its own members are ids under the anonymous class's id, and the model must
    // contain them — proving the member ids and the class id agree.
    assertTrue(
        byId.keySet().stream().anyMatch(id -> id.startsWith(anonymous + ".")),
        () -> "no member of " + anonymous + " was emitted, so no edge can name one");

    List<String> viaSpoonName =
        byId.keySet().stream().filter(id -> id.startsWith("java:com.acme.order/Batch.")).toList();
    assertTrue(
        viaSpoonName.stream().noneMatch(id -> EntityIds.typeSimpleName(id).matches("\\d+.*")),
        () -> "the anonymous class also appears under Spoon's Batch$N name: " + viaSpoonName);
  }

  // ------------------------------------------------------------- fixtures

  private static List<JsonNode> edgesFrom(String id) {
    return run.edges().stream().filter(edge -> id.equals(edge.path("from").asText())).toList();
  }

  private static String describe(List<JsonNode> edges) {
    return edges.stream()
        .map(edge -> edge.path("edge").asText() + " -> " + edge.path("to").asText() + " @ " + anchorOf(edge))
        .collect(Collectors.joining("\n  ", "\n  ", ""));
  }

  private static String anchorOf(JsonNode edge) {
    JsonNode anchor = edge.path("anchor");
    return anchor.path("file").asText() + ":" + anchor.path("span").path(0).asInt();
  }

  @Test
  void theCorpusActuallyExercisesBothConstructs() {
    assertEquals(
        true,
        byId.containsKey("java:com.acme.order/Batch"),
        "fixtures/java/src/com/acme/order/Batch.java is what makes this file a regression test");
  }
}
