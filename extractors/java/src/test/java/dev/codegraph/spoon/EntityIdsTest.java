package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;
import spoon.support.compiler.VirtualFile;

/**
 * The id scheme is depended on by every extraction pass: a bug here corrupts
 * every id in the model and every edge endpoint. These tests pin the two things
 * that are easy to get wrong — erasure (generics, arrays, varargs, type
 * variables) and nesting — against a real Spoon model in noClasspath mode,
 * including types Spoon cannot resolve and types it INVENTS.
 */
class EntityIdsTest {

  private static final String ORDER_SERVICE =
      """
      package com.acme.order;

      import java.util.List;
      import com.nonexistent.external.MissingLib;

      public class OrderService {
        int count;

        public OrderService(String id) {}

        public Invoice bill(Order order) {
          Order copy = order;
          return null;
        }

        public Invoice bill(List<Order> orders, String... tags) {
          return null;
        }

        public <T extends Number> T max(T value, int[] samples) {
          return value;
        }

        public Runnable task() {
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
      }
      """;

  /**
   * An unresolvable generic instantiated with a diamond. Spoon RESOLVES type
   * arguments away for a type it knows, so this case only appears in noClasspath
   * — which is the mode the extractor runs in (measured on spring-petclinic:
   * {@code new MutableConfiguration<>()}).
   */
  private static final String DIAMOND =
      """
      package com.acme.cache;

      public class Caches {
        public Object build() {
          return new MutableConfiguration<>();
        }

        public Object pair() {
          return new Holder<String, Integer>();
        }
      }
      """;

  private static CtModel model;

  @BeforeAll
  static void buildModel() {
    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(new VirtualFile(ORDER_SERVICE, "OrderService.java"));
    launcher.addInputResource(new VirtualFile(LOOSE, "Loose.java"));
    launcher.addInputResource(new VirtualFile(DIAMOND, "Caches.java"));
    model = launcher.buildModel();
  }

  // ------------------------------------------------------------------ types

  @Test
  void topLevelTypeIdCarriesPackageAndName() {
    assertEquals("java:com.acme.order/OrderService", EntityIds.forType(orderService()));
  }

  @Test
  void defaultPackageIsSpelledUnnamed() {
    assertEquals("java:<unnamed>/Loose", EntityIds.forType(type("Loose")));
    assertEquals("java:<unnamed>", EntityIds.forPackageName(""));
    assertEquals("java:<unnamed>", EntityIds.forPackageName(null));
  }

  @Test
  void packageIdIsTheQualifiedPackageName() {
    assertEquals("java:com.acme.order", EntityIds.forPackage(orderService().getPackage()));
    assertEquals("java:com.acme.order", EntityIds.packageIdOfTypeId("java:com.acme.order/OrderService.Inner"));
  }

  /**
   * getAllTypes() does NOT contain nested types — an extractor trusting the name
   * drops every inner class. The id must nevertheless place Inner under Outer
   * with a dot, never Spoon's {@code $}.
   */
  @Test
  void nestedTypeIdIsDotSeparatedUnderItsOuterType() {
    CtType<?> inner = orderService().getNestedTypes().iterator().next();
    assertEquals("java:com.acme.order/OrderService.Inner", EntityIds.forType(inner));
    assertTrue(
        model.getAllTypes().stream().noneMatch(t -> t.getSimpleName().equals("Inner")),
        "guard: nested types are not in getAllTypes(), so the whitelist must recurse");
  }

  @Test
  void nestedTypeReferenceIdMatchesTheDeclarationId() {
    CtField<?> inner = type("Loose").getField("inner");
    assertEquals(
        "java:com.acme.order/OrderService.Inner", EntityIds.forTypeReference(inner.getType()));
  }

  /**
   * THE hazard (PLAN.md §5.2): Order and Invoice exist nowhere, yet Spoon
   * reports them under the enclosing package. The id is built from what Spoon
   * says — and is indistinguishable in shape from a real one, which is exactly
   * why membership is the whitelist's job and never a prefix test.
   */
  @Test
  void inventedFullyQualifiedNamesProduceOrdinaryLookingTypeIds() {
    CtMethod<?> bill = method("bill", 1);
    assertEquals("java:com.acme.order/Invoice", EntityIds.forTypeReference(bill.getType()));
    assertEquals(
        "java:com.acme.order/Order",
        EntityIds.forTypeReference(bill.getParameters().get(0).getType()));
  }

  @Test
  void unresolvableImportedTypeKeepsItsDeclaredPackage() {
    CtMethod<?> external = method("external", 0);
    assertEquals("java:com.nonexistent.external/MissingLib", EntityIds.forTypeReference(external.getType()));
  }

  @Test
  void unresolvableTypeInTheDefaultPackageIsUnnamed() {
    CtField<?> dangling = type("Loose").getField("dangling");
    assertEquals("java:<unnamed>/Unresolvable", EntityIds.forTypeReference(dangling.getType()));
  }

  @Test
  void anonymousTypesAreRejectedByForType() {
    IllegalArgumentException error =
        assertThrows(IllegalArgumentException.class, () -> EntityIds.forType(null));
    assertTrue(error.getMessage().contains("null type"));
  }

  // --------------------------------------------------------------- erasure

  @Test
  void genericArgumentsAreErasedFromIds() {
    CtMethod<?> billList = method("bill", 2);
    assertEquals(
        "java:com.acme.order/OrderService.bill(java.util.List,java.lang.String[])",
        EntityIds.forMethod(billList));
  }

  @Test
  void varargsRenderAsArrays() {
    CtMethod<?> billList = method("bill", 2);
    assertTrue(EntityIds.forMethod(billList).endsWith("java.lang.String[])"));
  }

  @Test
  void arraysKeepTheirBracketsAndTypeVariablesEraseToTheirBound() {
    assertEquals(
        "java:com.acme.order/OrderService.max(java.lang.Number,int[])", EntityIds.forMethod(method("max", 2)));
  }

  /**
   * Erasure has to hold for types Spoon could NOT resolve, which is the only
   * place the argument list survives into the name. Left alone,
   * {@code MutableConfiguration<>} and {@code Holder<String,Integer>} become
   * entity ids of their own — one type per argument list, each with a share of
   * the real type's fan-in.
   */
  @Test
  void typeArgumentsAreErasedEvenWhenSpoonCouldNotResolveTheType() {
    for (CtTypeReference<?> reference :
        model.getElements(new TypeFilter<CtTypeReference<?>>(CtTypeReference.class))) {
      String id = EntityIds.forTypeReference(reference);
      assertFalse(
          id.contains("<") && !id.contains("<unnamed>") && !id.contains("<unknown>"),
          () -> "type arguments survived into an id: " + id);
    }
    assertEquals(
        "java:com.acme.cache/MutableConfiguration",
        EntityIds.forTypeReference(instantiated("MutableConfiguration")),
        "Spoon invents the enclosing package for an unresolved type (that is §5.2's hazard, and "
            + "the whitelist's job); the id must at least be ERASED, or one type splits in two");
    assertEquals(
        "java:com.acme.cache/Holder", EntityIds.forTypeReference(instantiated("Holder")));
  }

  @Test
  void erasedTypeNameDropsTypeArgumentsButKeepsArrayDepth() {
    CtMethod<?> billList = method("bill", 2);
    CtTypeReference<?> listOfOrder = billList.getParameters().get(0).getType();
    assertEquals("java.util.List", EntityIds.erasedTypeName(listOfOrder));
    assertEquals("int[]", EntityIds.erasedTypeName(method("max", 2).getParameters().get(1).getType()));
  }

  /**
   * The decision that departs from METAMODEL §10's illustrative {@code bill(Order)}:
   * parameter types are fully qualified, because {@code f(java.util.List)} and
   * {@code f(java.awt.List)} are legal overloads that simple names would merge
   * into one entity.
   */
  @Test
  void overloadsGetDistinctIdsThroughFullyQualifiedParameterTypes() {
    String one = EntityIds.forMethod(method("bill", 1));
    String two = EntityIds.forMethod(method("bill", 2));
    assertNotEquals(one, two);
    assertEquals("java:com.acme.order/OrderService.bill(com.acme.order.Order)", one);
  }

  // --------------------------------------------------------------- members

  @Test
  void methodIdAndSignatureAgreeOnTheParameterRendering() {
    CtMethod<?> bill = method("bill", 1);
    assertEquals("bill(com.acme.order.Order)", EntityIds.signatureOf(bill));
    assertEquals("java:com.acme.order/OrderService." + EntityIds.signatureOf(bill), EntityIds.forMethod(bill));
  }

  /**
   * Also pins that erasure leaves {@code <init>} alone: a leading {@code <} is
   * the JVM's name for a constructor, not the start of a type-argument list.
   * The constructor is selected by its declaring type rather than by position in
   * the model — adding a fixture file must not silently retarget this test.
   */
  @Test
  void constructorUsesInitAndHasNoName() {
    CtConstructor<?> constructor =
        model.getElements(new TypeFilter<CtConstructor<?>>(CtConstructor.class)).stream()
            .filter(candidate -> "OrderService".equals(candidate.getDeclaringType().getSimpleName()))
            .findFirst()
            .orElseThrow(() -> new AssertionError("OrderService declares a constructor"));
    assertEquals("<init>(java.lang.String)", EntityIds.signatureOf(constructor));
    assertEquals(
        "java:com.acme.order/OrderService.<init>(java.lang.String)", EntityIds.forConstructor(constructor));
  }

  @Test
  void fieldIdIsTheOwnerPlusItsName() {
    assertEquals("java:com.acme.order/OrderService.count", EntityIds.forField(orderService().getField("count")));
  }

  @Test
  void parameterIdHangsOffTheOwningExecutable() {
    CtMethod<?> bill = method("bill", 1);
    assertEquals(
        "java:com.acme.order/OrderService.bill(com.acme.order.Order)#param:order",
        EntityIds.forParameter(bill.getParameters().get(0)));
  }

  @Test
  void localVariableIdCarriesItsLineToSurviveShadowing() {
    CtLocalVariable<?> local =
        method("bill", 1).getElements(new TypeFilter<>(CtLocalVariable.class)).get(0);
    String id = EntityIds.forLocalVariable(local);
    assertTrue(
        id.matches("\\Qjava:com.acme.order/OrderService.bill(com.acme.order.Order)\\E#local:copy:\\d+"),
        "unexpected local variable id: " + id);
  }

  @Test
  void lambdaIsIdentifiedByFileLineAndColumnBecauseItHasNoName() {
    CtLambda<?> lambda = model.getElements(new TypeFilter<>(CtLambda.class)).get(0);
    String id = EntityIds.forLambda(lambda, "OrderService.java");
    assertTrue(
        id.matches("\\Qjava:com.acme.order/OrderService\\E#OrderService\\.java:\\d+:\\d+"),
        "unexpected lambda id: " + id);
    assertEquals("()", EntityIds.signatureOf(lambda));
  }

  /** The column is what separates two nameless entities that share a line. */
  @Test
  void twoNamelessEntitiesOnOneLineGetDifferentIds() {
    String first = EntityIds.forAnonymous("java:p/T", "T.java", 11, 22);
    String second = EntityIds.forAnonymous("java:p/T", "T.java", 11, 65);
    assertEquals("java:p/T#T.java:11:22", first);
    assertNotEquals(first, second);
  }

  @Test
  void anAnonymousEntityNeedsABase1Column() {
    assertThrows(
        IllegalArgumentException.class, () -> EntityIds.forAnonymous("java:p/T", "T.java", 11, 0));
  }

  // ----------------------------------------------------- reading ids back

  @Test
  void stubNamingReadsTheSchemeBack() {
    assertEquals("Inner", EntityIds.typeSimpleName("java:com.acme.order/OrderService.Inner"));
    assertEquals("MissingLib", EntityIds.typeSimpleName("java:com.nonexistent.external/MissingLib"));
    assertEquals("OrderService.Inner", EntityIds.typeQualifiedName("java:com.acme.order/OrderService.Inner"));
  }

  // ------------------------------------------------------------- fixtures

  private static CtType<?> orderService() {
    return type("OrderService");
  }

  private static CtType<?> type(String simpleName) {
    return model.getAllTypes().stream()
        .filter(t -> t.getSimpleName().equals(simpleName))
        .findFirst()
        .orElseThrow(() -> new AssertionError("no such type in the fixture: " + simpleName));
  }

  /** The type reference of {@code new <simpleName>…()} — unresolved, so still generic. */
  private static CtTypeReference<?> instantiated(String simpleName) {
    return model
        .getElements(new TypeFilter<spoon.reflect.code.CtConstructorCall<?>>(spoon.reflect.code.CtConstructorCall.class))
        .stream()
        .map(call -> call.getType())
        .filter(reference -> reference != null && reference.getSimpleName().startsWith(simpleName))
        .findFirst()
        .orElseThrow(() -> new AssertionError("no `new " + simpleName + "` in the fixture"));
  }

  private static CtMethod<?> method(String name, int parameterCount) {
    List<CtMethod<?>> candidates =
        orderService().getMethodsByName(name).stream()
            .filter(m -> m.getParameters().size() == parameterCount)
            .toList();
    if (candidates.size() != 1) {
      throw new AssertionError("expected exactly one " + name + "/" + parameterCount + ", got " + candidates.size());
    }
    return candidates.get(0);
  }
}
