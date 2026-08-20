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
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Stub discipline (PLAN.md §5.2, CLAUDE.md invariants 6 and 10) — the property
 * M2 is most likely to get quietly wrong.
 *
 * <p>Spoon in noClasspath mode INVENTS fully-qualified names by assuming the
 * enclosing package. In the fixtures, {@code Invoice} is declared nowhere and
 * Spoon reports it as {@code com.acme.order.Invoice} — the same package as three
 * genuinely declared types. Any membership test based on a package or name
 * prefix therefore launders a fabrication into a corpus fact, and no amount of
 * later analysis can tell the difference. Membership is the whitelist of ids the
 * corpus DECLARED, and nothing else.
 */
class StubDisciplineTest {

  /** METAMODEL.md §6: a stub type is a degraded TYPE node — a name, and nothing it cannot evidence. */
  private static final Set<String> TYPE_STUB_REQUIRED = Set.of("TNamed", "TType");

  /**
   * The ONLY thing a stub type may add: which external module it belongs to. The
   * analyzer folds to module level by walking {@code parent} and may not parse
   * ids, so without this an external type could not be placed in a module at all
   * — and the workaround (folding it onto itself) put classes, and even
   * primitives, into module dependency graphs as if they were modules.
   */
  private static final Set<String> TYPE_STUB_ALLOWED = Set.of("TNamed", "TType", "TChildOf");

  /**
   * A stub PACKAGE is the module-level counterpart. It keeps TWithChildren
   * because the import graph is module-level (METAMODEL.md §9) and an import edge
   * needs an endpoint that exists; {@code definedIn: []} is what marks it external.
   */
  private static final Set<String> PACKAGE_STUB_TRAITS = Set.of("TNamed", "TModule", "TWithChildren");

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

  // -------------------------------------------------- the shape of a stub

  @Test
  void everyStubIsADegradedNodeAndNothingMore() {
    for (JsonNode entity : stubs()) {
      String id = entity.path("id").asText();
      String kind = entity.path("kind").asText();
      Set<String> traits = Set.copyOf(ExtractorHarness.traitsOf(entity));

      // Exactly two shapes are stubbable, because exactly two traits contribute
      // `isStub`: TType (an external type) and TModule (an external package).
      if ("package".equals(kind)) {
        assertEquals(
            PACKAGE_STUB_TRAITS, traits, () -> "package stub " + id + " must carry exactly " + PACKAGE_STUB_TRAITS);
        assertTrue(
            entity.path("definedIn").isEmpty(),
            () -> "package stub " + id + " claims a corpus file — then it would not be external");
        // Children are the external types this corpus referenced, never corpus
        // entities: a stub module may not claim to contain declared code.
        for (JsonNode child : entity.path("children")) {
          JsonNode target = byId.get(child.asText());
          assertTrue(
              target != null && target.path("isStub").asBoolean(),
              () -> "package stub " + id + " claims a non-stub child " + child.asText());
        }
      } else {
        assertEquals("class", kind, () -> "type stub " + id + " must be kind class");
        assertTrue(
            traits.containsAll(TYPE_STUB_REQUIRED),
            () -> "type stub " + id + " must carry at least " + TYPE_STUB_REQUIRED + ", has " + traits);
        assertTrue(
            TYPE_STUB_ALLOWED.containsAll(traits),
            () -> "type stub " + id + " carries a trait it cannot evidence: " + traits);
        assertFalse(entity.has("children"), () -> "stub " + id + " carries children");
      }

      assertTrue(entity.hasNonNull("name"), () -> "stub " + id + " has TNamed but no name");
      assertFalse(
          entity.has("anchor"),
          () -> "stub " + id + " carries an anchor — a stub is not declared anywhere in the corpus");

      // THE PROPERTY THE OLD "a stub has no parent" ASSERTION WAS REALLY GUARDING:
      // an external type must never be attributed to a CORPUS module, which would
      // make it look internal to every module-level analysis. Having a parent is
      // fine; having a non-stub one is the actual violation. There is no second
      // direction to agree with any more (MM-2): `children` is derived.
      if (entity.has("parent")) {
        String parentId = entity.path("parent").asText();
        JsonNode parent = byId.get(parentId);
        assertTrue(
            parent != null && parent.path("isStub").asBoolean(),
            () -> "stub " + id + " is attributed to non-stub " + parentId + " — it would read as internal");
        assertEquals(
            "package", parent.path("kind").asText(), () -> "stub " + id + " must hang off a module");
        assertTrue(
            ExtractorHarness.traitsOf(parent).contains("TWithChildren"),
            () -> "the module " + parentId + " does not declare itself a container");
      }
    }
  }

  /**
   * The import layer is only first-class (CLAUDE.md invariant 9) if its endpoints
   * exist. Every one of these is imported by the fixtures and declared by no
   * corpus file, so each must appear as a degraded module rather than dangle.
   */
  @Test
  void externalPackagesReachedByImportEdgesExistAsModuleStubs() {
    for (String external :
        List.of("java:java.util", "java:java.time", "java:com.megacorp.ledger")) {
      JsonNode entity = byId.get(external);
      assertTrue(
          entity != null,
          () -> external + " is an import target but no entity declares it — the import layer dangles");
      assertTrue(entity.path("isStub").asBoolean(), () -> external + " is outside the corpus");
      assertEquals("package", entity.path("kind").asText(), () -> external + " must stay a package");
    }
  }

  @Test
  void theCorpusProducesStubs() {
    assertFalse(
        stubs().isEmpty(),
        "the fixture corpus references types it does not declare, so it must produce stubs");
  }

  // ---------------------------------------- membership is not a prefix test

  /**
   * THE regression this whole file exists for. {@code com.acme.order.Invoice} is
   * a Spoon fabrication that shares its package with declared corpus types. If it
   * ever comes out with {@code isStub: false}, membership has degenerated into a
   * prefix test and every "internal" claim the model makes is suspect.
   */
  @Test
  void aSpoonInventedTypeIsAStubDespiteSharingTheCorpusPackage() {
    String invented = "java:com.acme.order/Invoice";
    JsonNode entity = byId.get(invented);
    assertTrue(
        entity != null,
        () ->
            invented
                + " is missing from the model — the fixture references it, so it must appear "
                + "as a stub. Entities in that package: "
                + idsUnder("java:com.acme.order/"));
    assertTrue(
        entity.path("isStub").asBoolean(),
        () ->
            invented
                + " was emitted as a corpus type. It is declared NOWHERE — Spoon invented the "
                + "FQN from the enclosing package. Membership must come from the declared-id "
                + "whitelist, never from a package prefix (PLAN.md §5.2).");
  }

  @Test
  void typesTheCorpusActuallyDeclaresAreNotStubs() {
    for (String declared :
        List.of(
            "java:com.acme.order/OrderService",
            "java:com.acme.order/Order",
            "java:com.acme.order/AbstractOrder",
            "java:com.acme.order/Priceable",
            "java:com.acme.order/Discountable",
            "java:com.acme.order/Money",
            "java:com.acme.order/Channel",
            "java:com.acme.order/Audited",
            // Nested types: absent from getAllTypes(), so an extractor that does not
            // recurse getNestedTypes() drops them AND stubs every reference to them.
            "java:com.acme.order/Basket.Line",
            "java:com.acme.order/Basket.Line.Discount",
            "java:com.acme.order/Basket.Cursor",
            // A second package, and the simple-name collision partner of java.util.List.
            "java:com.acme.order.adapter/LedgerAdapter",
            "java:com.acme.order.legacy/List")) {
      JsonNode entity = byId.get(declared);
      assertTrue(entity != null, () -> declared + " is declared by the fixtures but absent from the model");
      assertFalse(
          entity.path("isStub").asBoolean(),
          () -> declared + " is declared by the fixtures and must not be a stub");
    }
  }

  /**
   * Resolvability is not membership: {@code java.util.List} resolves against the
   * JDK on the test classpath, {@code LedgerClient} resolves against nothing. Both
   * are outside the corpus, so both are stubs if they appear at all. Asserted as
   * "never internal" rather than "always present", because whether a given
   * external type is referenced depends on which edges the extractor emits.
   *
   * <p>{@code java.util.List} is also the simple-name twin of the corpus's own
   * {@code com.acme.order.legacy.List}: if ids ever fell back to simple names the
   * two would merge, and one of them would inherit the other's membership answer.
   */
  @Test
  void typesOutsideTheCorpusAreNeverInternalWhetherOrNotSpoonResolvedThem() {
    for (String external :
        List.of(
            "java:java.util/List",
            "java:java.util/ArrayList",
            "java:java.lang/String",
            "java:java.lang/Runnable",
            "java:com.megacorp.ledger/LedgerClient")) {
      JsonNode entity = byId.get(external);
      if (entity != null) {
        assertTrue(
            entity.path("isStub").asBoolean(),
            () -> external + " is outside the corpus and must be a stub");
      }
    }
    assertTrue(
        byId.containsKey("java:com.megacorp.ledger/LedgerClient"),
        () ->
            "the unresolvable external import is referenced by the fixtures (OrderService.ledger) "
                + "and must survive as a stub; stubs present: "
                + stubs().stream().map(e -> e.path("id").asText()).collect(Collectors.joining(", ")));
  }

  /**
   * A KNOWN LOSS, pinned so it cannot quietly get worse or quietly get fixed.
   *
   * <p>The lambda/anonymous id is {@code Type#file:startLine} (PLAN.md §4.6,
   * locked for M2). {@code Notifications.java:11} starts TWO lambdas, so they
   * share an id and the extractor keeps the first in AST order. The corpus holds
   * 5 nameless invocables; the model holds 4.
   *
   * <p>Stated as the PROPERTY rather than as a corpus-wide count, so that adding
   * a fixture file (as the array/anonymous audit did) does not read as the id
   * scheme changing. The property: the id
   * {@code Notifications#…/Notifications.java:11} is emitted exactly once even
   * though line 11 starts two lambdas, and no lambda id is emitted twice. When
   * the disambiguator gains a column or an ordinal, THIS test fails — and the
   * fix is to assert two distinct ids on line 11, never to delete the assertion.
   */
  @Test
  void lambdasSharingALineCollapseIntoOneEntityAndTheLossIsBounded() {
    List<String> nameless =
        run.entities().stream()
            .filter(entity -> "lambda".equals(entity.path("kind").asText()))
            .map(entity -> entity.path("id").asText())
            .sorted()
            .toList();

    String collision = "java:com.acme.order/Notifications#com/acme/order/Notifications.java:11";
    assertEquals(
        1,
        nameless.stream().filter(collision::equals).count(),
        () ->
            "Notifications.java:11 starts TWO lambdas: `chain(() -> …, () -> …)`. The id scheme is "
                + "Type#file:startLine (PLAN.md §4.6, locked for M2), so they share an id and the "
                + "first in AST order wins — one real lambda is absent from the model and nothing "
                + "distinguishes that from a lambda never written. Nameless invocables emitted: "
                + nameless);
    assertEquals(
        nameless.size(), Set.copyOf(nameless).size(), "lambda ids must still be unique: " + nameless);
  }

  // --------------------------------------------------------- graph closure

  /**
   * CLAUDE.md invariant 10: no edge, parent or child may point at an unknown id —
   * stubs count as known. This is the property that makes the whole model
   * loadable; a dangling id is an extraction bug that silently becomes an
   * analyzer crash three phases later.
   */
  @Test
  void everyReferencedIdResolvesToAnEntityInTheModel() {
    List<String> dangling = new ArrayList<>();

    for (JsonNode edge : run.edges()) {
      String where = edge.path("edge").asText() + " edge at " + anchorOf(edge);
      check(dangling, edge.path("from").asText(), where + " (from)");
      check(dangling, edge.path("to").asText(), where + " (to)");
      for (JsonNode candidate : edge.path("candidates")) {
        check(dangling, candidate.asText(), where + " (candidate)");
      }
    }

    for (JsonNode entity : run.entities()) {
      String id = entity.path("id").asText();
      for (String key : List.of("parent", "attachedTo", "declaredType")) {
        if (entity.hasNonNull(key)) {
          check(dangling, entity.path(key).asText(), id + "." + key);
        }
      }
      for (String key : List.of("children", "parameters", "localVariables")) {
        for (JsonNode reference : entity.path(key)) {
          check(dangling, reference.asText(), id + "." + key);
        }
      }
    }

    assertTrue(
        dangling.isEmpty(),
        () ->
            dangling.size()
                + " reference(s) point at ids no entity declares:\n  "
                + String.join("\n  ", new ArrayList<>(new LinkedHashSet<>(dangling))));
  }

  /** METAMODEL.md §4: {@code from ≠ to}. Main drops self-edges; none may survive. */
  @Test
  void noEdgePointsAtItself() {
    List<String> selfEdges =
        run.edges().stream()
            .filter(edge -> edge.path("from").asText().equals(edge.path("to").asText()))
            .map(edge -> edge.path("edge").asText() + " " + edge.path("from").asText() + " @ " + anchorOf(edge))
            .toList();
    assertTrue(selfEdges.isEmpty(), () -> "self-referencing edges survived:\n  " + String.join("\n  ", selfEdges));
  }

  // ------------------------------------------------------------- fixtures

  private static List<JsonNode> stubs() {
    return run.entities().stream().filter(entity -> entity.path("isStub").asBoolean()).toList();
  }

  private static void check(List<String> dangling, String id, String where) {
    if (!id.isEmpty() && !byId.containsKey(id)) {
      dangling.add(id + "  <- " + where);
    }
  }

  private static String idsUnder(String prefix) {
    return byId.keySet().stream().filter(id -> id.startsWith(prefix)).collect(Collectors.joining(", "));
  }

  private static String anchorOf(JsonNode edge) {
    JsonNode anchor = edge.path("anchor");
    return anchor.path("file").asText() + ":" + anchor.path("span").path(0).asInt();
  }
}
