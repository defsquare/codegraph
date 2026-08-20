package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;

/**
 * Pass 1 decides, for the whole milestone, what is corpus code and what is the
 * outside world. These tests pin the two ways that decision goes wrong: trusting
 * a package prefix (Spoon INVENTS fully-qualified names in noClasspath mode) and
 * trusting resolvability ({@code java.lang.String} resolves and is still not
 * corpus code).
 *
 * <p>The fixture is written to real files rather than {@code VirtualFile}s
 * because lambda and anonymous-class ids embed their root-relative path — a
 * virtual compilation unit has no file, so that half of the scheme would never
 * be exercised.
 */
class CorpusWhitelistTest {

  private static final String ORDER_SERVICE =
      """
      package com.acme.order;

      import java.util.List;
      import com.nonexistent.external.MissingLib;

      public class OrderService {

        int count;

        public OrderService(String id) {
          int seed = id.length();
        }

        public Invoice bill(Order order) {
          Order copy = order;
          return null;
        }

        public Invoice bill(List<Order> orders, String... tags) {
          return null;
        }

        public Runnable task() {
          class Helper {
            void go() {}
          }
          Runnable anonymous =
              new Runnable() {
                public void run() {
                  int inside = 1;
                }
              };
          return () -> count++;
        }

        public MissingLib external() {
          return null;
        }

        public static class Inner {
          void ping() {}
        }
      }
      """;

  private static final String LOOSE =
      """
      public class Loose {
        com.acme.order.OrderService.Inner inner;
        Unresolvable dangling;
        String label;
      }
      """;

  private static final String TYPE = "java:com.acme.order/OrderService";
  private static final String BILL_ORDER = TYPE + ".bill(com.acme.order.Order)";

  @TempDir static Path corpus;

  private static CtModel model;
  private static CorpusWhitelist whitelist;

  @BeforeAll
  static void buildModel() throws IOException {
    Path packaged = Files.createDirectories(corpus.resolve("com/acme/order"));
    Files.writeString(packaged.resolve("OrderService.java"), ORDER_SERVICE);
    Files.writeString(corpus.resolve("Loose.java"), LOOSE);

    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(corpus.toString());
    model = launcher.buildModel();

    whitelist = CorpusWhitelist.build(model, new Anchors(corpus));
  }

  // ------------------------------------------------------- THE hazard (§5.2)

  /**
   * Order and Invoice exist in no file of the corpus; Spoon reports them under
   * the enclosing package because that is the only guess it can make. A prefix
   * test on {@code com.acme.*} would call both internal — the whole reason
   * membership is a set of declared ids.
   */
  @Test
  void inventedFullyQualifiedNamesAreNotCorpusMembers() {
    List<String> invented =
        orderService().getReferencedTypes().stream()
            .filter(r -> r.getQualifiedName().equals("com.acme.order.Order")
                || r.getQualifiedName().equals("com.acme.order.Invoice"))
            .peek(
                r ->
                    assertFalse(
                        r.getTypeDeclaration() != null,
                        "guard: " + r.getQualifiedName() + " must be unresolvable — it exists nowhere"))
            .map(r -> r.getQualifiedName())
            .sorted()
            .toList();
    assertEquals(
        List.of("com.acme.order.Invoice", "com.acme.order.Order"),
        invented,
        "guard: Spoon must still be inventing these FQNs, or this test proves nothing");

    assertTrue(whitelist.declares(TYPE), "the real type in that package IS declared");
    assertFalse(whitelist.declares("java:com.acme.order/Order"));
    assertFalse(whitelist.declares("java:com.acme.order/Invoice"));
  }

  /** Resolvable is not internal: the JDK is on the classpath and is not corpus code. */
  @Test
  void resolvableJdkTypesAreNotCorpusMembers() {
    CtTypeReference<?> string = type("Loose").getField("label").getType();
    assertTrue(string.getTypeDeclaration() != null, "guard: java.lang.String resolves");
    assertEquals("java:java.lang/String", EntityIds.forTypeReference(string));
    assertFalse(whitelist.declaresType(string), "resolvability is not corpus membership");
  }

  /** …and unresolvable is not external either — the two questions are unrelated. */
  @Test
  void unresolvableCorpusTypesAreStillCorpusMembers() {
    CtTypeReference<?> inner = type("Loose").getField("inner").getType();
    assertTrue(whitelist.declaresType(inner), "OrderService.Inner is declared in the corpus");
  }

  // -------------------------------------------------------------------- types

  @Test
  void nestedTypesAreDeclaredEvenThoughGetAllTypesOmitsThem() {
    assertTrue(
        model.getAllTypes().stream().noneMatch(t -> t.getSimpleName().equals("Inner")),
        "guard: getAllTypes() does not return nested types");
    assertTrue(whitelist.declares(TYPE + ".Inner"));
    assertTrue(whitelist.declares(TYPE + ".Inner.ping()"));
  }

  @Test
  void localAndAnonymousClassesAreDeclared() {
    assertTrue(
        whitelist.ids().stream().anyMatch(id -> id.matches("\\Q" + TYPE + ".\\E\\d*Helper")),
        () -> "no local class in " + whitelist.ids());
    assertTrue(
        whitelist.ids().stream()
            .anyMatch(id -> id.matches("\\Q" + TYPE + "\\E#com/acme/order/OrderService\\.java:\\d+:\\d+\\.run\\(\\)")),
        () -> "no anonymous-class method in " + whitelist.ids());
  }

  @Test
  void defaultPackageTypesAreDeclared() {
    assertTrue(whitelist.declares("java:<unnamed>"));
    assertTrue(whitelist.declares("java:<unnamed>/Loose"));
  }

  /**
   * Spoon materializes the ancestor packages it needs ({@code com},
   * {@code com.acme}); no compilation unit declares them, so they are not corpus
   * entities. Only a package a corpus type is written in is declared.
   */
  @Test
  void emptyAncestorPackagesAreNotDeclared() {
    assertTrue(whitelist.declares("java:com.acme.order"));
    assertFalse(whitelist.declares("java:com"));
    assertFalse(whitelist.declares("java:com.acme"));
  }

  // ------------------------------------------------------------------ members

  @Test
  void everyMemberKindIsDeclared() {
    assertTrue(whitelist.declares(TYPE + ".count"), "field");
    assertTrue(whitelist.declares(TYPE + ".<init>(java.lang.String)"), "constructor");
    assertTrue(whitelist.declares(BILL_ORDER), "method");
    assertTrue(
        whitelist.declares(TYPE + ".bill(java.util.List,java.lang.String[])"), "overload");
    assertTrue(whitelist.declares(BILL_ORDER + "#param:order"), "parameter");
    assertTrue(
        whitelist.ids().stream().anyMatch(id -> id.matches("\\Q" + BILL_ORDER + "\\E#local:copy:\\d+")),
        "local variable");
    assertTrue(
        whitelist.ids().stream()
            .anyMatch(id -> id.matches("\\Q" + TYPE + ".<init>(java.lang.String)\\E#local:seed:\\d+")),
        "local variable in a constructor");
  }

  /**
   * A default constructor is written nowhere, yet {@code new Inner()} targets
   * corpus code — calling it external would be the lie the whitelist exists to
   * prevent. It is therefore declared, and the entity pass owes it an entity
   * (anchored to its declaring type, since it has no position of its own).
   */
  @Test
  void implicitDefaultConstructorsAreCorpusMembers() {
    assertTrue(whitelist.declares(TYPE + ".Inner.<init>()"));
  }

  @Test
  void lambdasAreDeclaredUnderTheirEnclosingNamedType() {
    assertTrue(
        whitelist.ids().stream()
            .anyMatch(id -> id.matches("\\Q" + TYPE + "\\E#com/acme/order/OrderService\\.java:\\d+:\\d+")),
        () -> "no lambda id in " + whitelist.ids());
  }

  /** A {@code <T>} is not an entity, however much CtTypeParameter implements CtType. */
  @Test
  void typeParametersAreNotEntities() {
    assertTrue(
        whitelist.ids().stream().noneMatch(id -> id.endsWith("/T")),
        () -> "a type parameter leaked into the whitelist: " + whitelist.ids());
  }

  // ------------------------------------------------------------- the set itself

  @Test
  void idsAreSortedAndImmutable() {
    List<String> ids = List.copyOf(whitelist.ids());
    assertEquals(ids.stream().sorted().toList(), ids, "iteration order must be sorted, not salted");
    assertThrows(UnsupportedOperationException.class, () -> whitelist.ids().add("java:x/Y"));
    assertEquals(ids.size(), whitelist.size());
  }

  @Test
  void buildIsDeterministic() {
    assertEquals(
        List.copyOf(CorpusWhitelist.build(model, new Anchors(corpus)).ids()),
        List.copyOf(CorpusWhitelist.build(model, new Anchors(corpus)).ids()));
  }

  /**
   * The single-argument form Main calls has to infer the root from the sources;
   * for the standard package-mirroring layout it must land on the same ids the
   * pipeline's own Anchors produce, or every lambda id would disagree.
   */
  @Test
  void theInferredRootMatchesThePackageMirroringLayout() {
    assertEquals(List.copyOf(whitelist.ids()), List.copyOf(CorpusWhitelist.build(model).ids()));
  }

  @Test
  void ofRejectsBlankIds() {
    assertThrows(IllegalArgumentException.class, () -> CorpusWhitelist.of(List.of(" ")));
  }

  // ------------------------------------------------------------------ fixtures

  private static CtType<?> orderService() {
    return type("OrderService");
  }

  private static CtType<?> type(String simpleName) {
    return model.getAllTypes().stream()
        .filter(t -> t.getSimpleName().equals(simpleName))
        .findFirst()
        .orElseThrow(() -> new AssertionError("no such type in the fixture: " + simpleName));
  }
}
