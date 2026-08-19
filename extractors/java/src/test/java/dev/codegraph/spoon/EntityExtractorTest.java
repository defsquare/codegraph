package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;

/**
 * Pass 2 against a real corpus on disk (anchors must relativize, and Spoon's
 * virtual files carry no path). The fixture deliberately contains the constructs
 * that break naive extractors: a nested class, a local class, an anonymous class,
 * two lambdas — one in a field initializer, one in a static block — overloads,
 * a record, an enum, an annotation type, and types that exist nowhere.
 */
class EntityExtractorTest {

  private static final String ORDER_SERVICE =
      """
      package com.acme.order;

      import java.util.List;

      /** Bills orders. */
      public class OrderService {
        int count;
        Runnable fromField = () -> System.out.println("field");

        static {
          Runnable fromStatic = () -> System.out.println("static");
        }

        public OrderService(String id) {}

        public Invoice bill(Order order) {
          Order copy = order;
          Runnable anon = new Runnable() {
            int captured;
            public void run() {
              int deep = 1;
            }
          };
          class Local {
            void ping() {}
          }
          return null;
        }

        public void bill(List<Order> orders, String... tags) {}

        public static class Inner {
          void ping() {}
        }

        interface Face { void f(); }

        enum Color implements Face { RED; public void f() {} }

        record Point(int x, int y) implements Face { public void f() {} }

        @interface Marker { String value(); }
      }
      """;

  private static final String LOOSE =
      """
      public class Loose {
        Unresolvable dangling;
      }
      """;

  /** The Java profile (packages/core/src/profiles/java.ts), pinned per kind. */
  private static final Map<String, Set<TraitName>> REQUIRED =
      Map.ofEntries(
          Map.entry("package", traits(TraitName.TNamed, TraitName.TModule, TraitName.TWithChildren)),
          Map.entry(
              "class",
              traits(
                  TraitName.TNamed,
                  TraitName.TType,
                  TraitName.TWithInheritances,
                  TraitName.TWithImplements,
                  TraitName.TWithChildren,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "interface",
              traits(
                  TraitName.TNamed,
                  TraitName.TType,
                  TraitName.TWithInheritances,
                  TraitName.TWithChildren,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "enum",
              traits(
                  TraitName.TNamed,
                  TraitName.TType,
                  TraitName.TWithImplements,
                  TraitName.TWithChildren,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "record",
              traits(
                  TraitName.TNamed,
                  TraitName.TType,
                  TraitName.TWithImplements,
                  TraitName.TWithChildren,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "annotation",
              traits(
                  TraitName.TNamed,
                  TraitName.TType,
                  TraitName.TWithChildren,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "method",
              traits(
                  TraitName.TNamed,
                  TraitName.TInvocable,
                  TraitName.TWithParameters,
                  TraitName.TWithLocalVariables,
                  TraitName.TWithInvocations,
                  TraitName.TWithAccesses,
                  TraitName.TTypedEntity,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "constructor",
              traits(
                  TraitName.TInvocable,
                  TraitName.TWithParameters,
                  TraitName.TWithLocalVariables,
                  TraitName.TWithInvocations,
                  TraitName.TWithAccesses,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "lambda",
              traits(
                  TraitName.TInvocable,
                  TraitName.TWithParameters,
                  TraitName.TWithLocalVariables,
                  TraitName.TWithInvocations,
                  TraitName.TWithAccesses,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "attribute",
              traits(
                  TraitName.TNamed,
                  TraitName.TStructural,
                  TraitName.TTypedEntity,
                  TraitName.TChildOf,
                  TraitName.TSourceAnchor)),
          Map.entry(
              "parameter",
              traits(
                  TraitName.TNamed,
                  TraitName.TStructural,
                  TraitName.TTypedEntity,
                  TraitName.TChildOf)),
          Map.entry(
              "localVariable",
              traits(
                  TraitName.TNamed,
                  TraitName.TStructural,
                  TraitName.TTypedEntity,
                  TraitName.TChildOf)));

  private static final Map<String, Set<TraitName>> OPTIONAL =
      Map.ofEntries(
          Map.entry("package", traits(TraitName.TComment)),
          Map.entry("class", traits(TraitName.TComment)),
          Map.entry("interface", traits(TraitName.TComment)),
          Map.entry("enum", traits(TraitName.TComment)),
          Map.entry("record", traits(TraitName.TComment)),
          Map.entry("annotation", traits(TraitName.TComment)),
          Map.entry("method", traits(TraitName.TComment)),
          Map.entry("constructor", traits(TraitName.TComment)),
          Map.entry("lambda", traits(TraitName.TTypedEntity)),
          Map.entry("attribute", traits(TraitName.TComment)),
          Map.entry("parameter", traits(TraitName.TSourceAnchor)),
          Map.entry("localVariable", traits(TraitName.TSourceAnchor)));

  private static final String TYPE = "java:com.acme.order/OrderService";
  private static final String BILL = TYPE + ".bill(com.acme.order.Order)";

  @TempDir static Path root;

  private static CtModel spoonModel;
  private static List<Entity> entities;
  private static Map<String, Entity> byId;

  @BeforeAll
  static void extract() throws IOException {
    write("com/acme/order/OrderService.java", ORDER_SERVICE);
    write("Loose.java", LOOSE);

    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(root.toString());
    spoonModel = launcher.buildModel();

    entities = extractOnce();
    Map<String, Entity> index = new LinkedHashMap<>();
    for (Entity entity : entities) {
      assertNull(index.put(entity.id(), entity), () -> "duplicate entity id: " + entity.id());
    }
    byId = Map.copyOf(index);
  }

  // ---------------------------------------------------------------- coverage

  /**
   * The measured hazard: {@code getAllTypes()} returns top-level types only, so
   * an extractor trusting it drops every inner class. Nested, local and
   * anonymous declarations must all reach the model.
   */
  @Test
  void nestedLocalAndAnonymousTypesAreAllExtracted() {
    assertTrue(
        spoonModel.getAllTypes().stream().noneMatch(t -> t.getSimpleName().equals("Inner")),
        "guard: if getAllTypes() started returning nested types this test would stop proving anything");

    assertEquals("class", kind(TYPE + ".Inner"));
    assertEquals("interface", kind(TYPE + ".Face"));
    assertEquals("enum", kind(TYPE + ".Color"));
    assertEquals("record", kind(TYPE + ".Point"));
    assertEquals("annotation", kind(TYPE + ".Marker"));
    assertEquals("method", kind(TYPE + ".Inner.ping()"));

    // A local class keeps Spoon's disambiguated id but is named as written.
    Entity local = entity(TYPE + ".1Local");
    assertEquals("class", local.kind());
    assertEquals("Local", local.name());
    assertEquals(BILL, local.parent(), "a local class is written inside its method");
  }

  @Test
  void lambdasAndAnonymousClassesAreNamelessInvocablesKeyedByFileAndLine() {
    List<Entity> nameless =
        entities.stream().filter(e -> e.kind().equals("lambda")).toList();
    assertEquals(3, nameless.size(), () -> "expected two lambdas and one anonymous class: " + ids(nameless));

    for (Entity entity : nameless) {
      assertFalse(entity.traits().contains(TraitName.TNamed), () -> entity.id() + " must have no name");
      assertNull(entity.name());
      assertNotNull(entity.signature(), "TInvocable brings a signature even when there is no name");
      assertTrue(
          entity.id().matches("\\Qjava:com.acme.order/OrderService\\E#[^#]+\\.java:\\d+"),
          () -> "unexpected lambda id: " + entity.id());
    }

    // The anonymous class is named after what it instantiates; a lambda by its parameters.
    assertTrue(
        nameless.stream().anyMatch(e -> e.signature().equals("java.lang.Runnable()")),
        () -> "no anonymous class signature in " + nameless.stream().map(Entity::signature).toList());
    assertTrue(nameless.stream().anyMatch(e -> e.signature().equals("()")));
  }

  /**
   * A lambda in a field initializer or a static block is written in the type; one
   * in a method body is written in the method. Both must land on an entity that
   * exists, never on an initializer block (which is not an entity at all).
   */
  @Test
  void lambdasHangOffTheNearestEnclosingEntity() {
    List<Entity> lambdas =
        entities.stream()
            .filter(e -> e.kind().equals("lambda") && e.signature().equals("()"))
            .toList();
    assertEquals(2, lambdas.size());
    for (Entity lambda : lambdas) {
      assertEquals(TYPE, lambda.parent());
      assertTrue(entity(TYPE).children().contains(lambda.id()));
    }

    Entity anonymousClass =
        entities.stream()
            .filter(e -> e.kind().equals("lambda") && e.signature().startsWith("java.lang.Runnable"))
            .findFirst()
            .orElseThrow();
    assertEquals(BILL, anonymousClass.parent());
    // Its members hang off it, which is why the anonymous entity must exist.
    assertEquals(anonymousClass.id(), entity(anonymousClass.id() + ".run()").parent());
    assertEquals(anonymousClass.id(), entity(anonymousClass.id() + ".captured").parent());
  }

  // ------------------------------------------------------------------ traits

  /**
   * The acceptance gate: {@code required ⊆ traits ⊆ required ∪ optional} per
   * kind. Trait sets are keyed off the kind, not off a class/interface family —
   * an interface never implements, an enum/record never extends.
   */
  @Test
  void everyEntityMatchesItsKindsTraitSet() {
    for (Entity entity : entities) {
      Set<TraitName> required = REQUIRED.get(entity.kind());
      assertNotNull(required, () -> "kind outside the Java profile: " + entity.kind());
      Set<TraitName> allowed = EnumSet.copyOf(required);
      allowed.addAll(OPTIONAL.get(entity.kind()));

      assertTrue(
          entity.traits().containsAll(required),
          () -> entity.id() + " is missing " + minus(required, entity.traits()));
      assertTrue(
          allowed.containsAll(entity.traits()),
          () -> entity.id() + " carries traits its kind forbids: " + minus(entity.traits(), allowed));
    }
  }

  @Test
  void interfacesNeverImplementAndEnumsAndRecordsNeverExtend() {
    assertFalse(entity(TYPE + ".Face").traits().contains(TraitName.TWithImplements));
    assertFalse(entity(TYPE + ".Color").traits().contains(TraitName.TWithInheritances));
    assertFalse(entity(TYPE + ".Point").traits().contains(TraitName.TWithInheritances));
    assertFalse(entity(TYPE + ".Marker").traits().contains(TraitName.TWithInheritances));
    assertFalse(entity(TYPE + ".Marker").traits().contains(TraitName.TWithImplements));
  }

  @Test
  void aConstructorHasNoNameAndNoReturnType() {
    Entity constructor = entity(TYPE + ".<init>(java.lang.String)");
    assertEquals("constructor", constructor.kind());
    assertFalse(constructor.traits().contains(TraitName.TNamed));
    assertNull(constructor.name());
    assertFalse(constructor.traits().contains(TraitName.TTypedEntity));
    assertNull(constructor.declaredType());
    assertEquals("<init>(java.lang.String)", constructor.signature());
  }

  @Test
  void everyTraitCarriesItsKeyAndNoKeyAppearsWithoutItsTrait() {
    for (Entity entity : entities) {
      assertEquals(entity.traits().contains(TraitName.TNamed), entity.name() != null, entity.id());
      assertEquals(entity.traits().contains(TraitName.TInvocable), entity.signature() != null, entity.id());
      assertEquals(entity.traits().contains(TraitName.TSourceAnchor), entity.anchor() != null, entity.id());
      assertEquals(entity.traits().contains(TraitName.TChildOf), entity.parent() != null, entity.id());
      assertEquals(entity.traits().contains(TraitName.TWithChildren), entity.children() != null, entity.id());
      assertEquals(entity.traits().contains(TraitName.TModule), entity.definedIn() != null, entity.id());
      // `isStub` is contributed by TType AND by TModule: an external package is a
      // degraded module exactly as an external type is a degraded type, which is
      // what lets the module-level import layer close (METAMODEL.md §6, §9).
      assertEquals(
          entity.traits().contains(TraitName.TType) || entity.traits().contains(TraitName.TModule),
          entity.isStub() != null,
          entity.id());
      assertEquals(entity.traits().contains(TraitName.TComment), entity.comments() != null, entity.id());
      assertEquals(
          entity.traits().contains(TraitName.TWithParameters), entity.parameters() != null, entity.id());
      assertEquals(
          entity.traits().contains(TraitName.TWithLocalVariables),
          entity.localVariables() != null,
          entity.id());
      // TTypedEntity's value is optional even when the trait is present, so only
      // the reverse implication holds.
      if (entity.declaredType() != null) {
        assertTrue(entity.traits().contains(TraitName.TTypedEntity), entity.id());
      }
      assertNull(entity.attachedTo(), "Java declares no semantic attachment");
    }
  }

  // ------------------------------------------------------------- containment

  /** METAMODEL.md §3.2: both directions are stored, so both must agree. */
  @Test
  void containmentAgreesInBothDirections() {
    Map<String, Set<String>> childrenByParent = new TreeMap<>();
    for (Entity entity : entities) {
      if (entity.parent() != null) {
        childrenByParent.computeIfAbsent(entity.parent(), key -> new TreeSet<>()).add(entity.id());
      }
    }
    for (Entity entity : entities) {
      if (entity.children() == null) {
        continue;
      }
      assertEquals(
          List.copyOf(childrenByParent.getOrDefault(entity.id(), Set.of())),
          entity.children(),
          () -> "children of " + entity.id() + " disagree with the entities claiming it as parent");
    }
  }

  /** Pass 2 must not emit a parent, child, parameter or local nothing declares. */
  @Test
  void containmentReferencesOnlyEmittedEntities() {
    for (Entity entity : entities) {
      assertTrue(
          entity.parent() == null || byId.containsKey(entity.parent()),
          () -> entity.id() + " has an unknown parent " + entity.parent());
      for (String id : orEmpty(entity.children())) {
        assertTrue(byId.containsKey(id), () -> entity.id() + " claims an unknown child " + id);
      }
      for (String id : orEmpty(entity.parameters())) {
        assertTrue(byId.containsKey(id), () -> entity.id() + " claims an unknown parameter " + id);
      }
      for (String id : orEmpty(entity.localVariables())) {
        assertTrue(byId.containsKey(id), () -> entity.id() + " claims an unknown local " + id);
      }
    }
  }

  @Test
  void aPackageOwnsItsTopLevelTypesAndNothingNested() {
    Entity pkg = entity("java:com.acme.order");
    assertEquals("package", pkg.kind());
    assertEquals("com.acme.order", pkg.name());
    assertEquals(List.of("com/acme/order/OrderService.java"), pkg.definedIn());
    assertTrue(pkg.children().contains(TYPE));
    assertFalse(
        pkg.children().stream().anyMatch(id -> id.startsWith(TYPE + ".")),
        "a nested type is a child of its outer type, not of the package");

    Entity unnamed = entity("java:<unnamed>");
    assertEquals("<unnamed>", unnamed.name());
    assertEquals(List.of("java:<unnamed>/Loose"), unnamed.children());
  }

  // ------------------------------------------------------------------ typing

  @Test
  void declaredTypeKeepsExternalAndInventedTypesSoTheStubLinkSurvives() {
    // Order and Invoice exist nowhere — Spoon invents their FQNs. Pass 2 records
    // the reference honestly; membership is pass 4's business, not a prefix test.
    assertEquals("java:com.acme.order/Invoice", entity(BILL).declaredType());
    assertEquals("java:com.acme.order/Order", entity(BILL + "#param:order").declaredType());
    assertEquals("java:java.lang/String", entity(TYPE + ".<init>(java.lang.String)#param:id").declaredType());
    assertEquals("java:<unnamed>/Unresolvable", entity("java:<unnamed>/Loose.dangling").declaredType());
  }

  @Test
  void voidIsTypedButHasNoDeclaredType() {
    Entity ping = entity(TYPE + ".Inner.ping()");
    assertTrue(ping.traits().contains(TraitName.TTypedEntity));
    assertNull(ping.declaredType(), "void is not a type entity");
  }

  @Test
  void aVarargsParameterIsTypedByItsComponentWhileTheSignatureKeepsTheArray() {
    String overload = TYPE + ".bill(java.util.List,java.lang.String[])";
    assertEquals("bill(java.util.List,java.lang.String[])", entity(overload).signature());
    assertEquals("java:java.lang/String", entity(overload + "#param:tags").declaredType());
  }

  // -------------------------------------------------------------- executables

  @Test
  void parametersKeepDeclarationOrder() {
    String overload = TYPE + ".bill(java.util.List,java.lang.String[])";
    assertEquals(
        List.of(overload + "#param:orders", overload + "#param:tags"),
        entity(overload).parameters());
  }

  /** A local inside an anonymous class's method belongs to that method, not to the enclosing one. */
  @Test
  void localsAreScopedToTheExecutableThatDeclaresThem() {
    Entity bill = entity(BILL);
    assertEquals(
        List.of(BILL + "#local:copy:17", BILL + "#local:anon:18"),
        bill.localVariables(),
        "locals are listed in source order and exclude anything nested deeper");

    Entity run =
        entities.stream()
            .filter(e -> e.kind().equals("method") && e.name().equals("run"))
            .findFirst()
            .orElseThrow();
    assertEquals(1, run.localVariables().size());
    assertTrue(run.localVariables().get(0).endsWith("#local:deep:21"), run.localVariables()::toString);
  }

  /**
   * Implicit members (a record's components and accessors, a default constructor)
   * are emitted anchored at the declaration that generates them: dropping them
   * would turn every {@code new Inner()} and {@code point.x()} into a dangling
   * reference and then into a fabricated stub.
   */
  @Test
  void implicitMembersAreEmittedAndAnchoredAtTheirDeclaration() {
    Entity record = entity(TYPE + ".Point");
    assertTrue(record.children().containsAll(List.of(TYPE + ".Point.x", TYPE + ".Point.x()")));
    Entity accessor = entity(TYPE + ".Point.x()");
    assertEquals(record.anchor().file(), accessor.anchor().file());
    assertEquals(record.anchor().startLine(), accessor.anchor().startLine());

    Entity defaultConstructor = entity(TYPE + ".Inner.<init>()");
    assertEquals("<init>()", defaultConstructor.signature());
    assertEquals(TYPE + ".Inner", defaultConstructor.parent());
  }

  @Test
  void javadocIsCarriedAsAComment() {
    assertEquals(List.of("Bills orders."), entity(TYPE).comments());
    assertFalse(entity(TYPE + ".count").traits().contains(TraitName.TComment));
  }

  // ------------------------------------------------------------ output shape

  @Test
  void anchorsAreRootRelativeAndOneBased() {
    for (Entity entity : entities) {
      if (entity.anchor() == null) {
        continue;
      }
      assertFalse(entity.anchor().file().startsWith("/"), () -> entity.id() + " has an absolute anchor");
      assertTrue(entity.anchor().startLine() >= 1, () -> entity.id() + " has a 0-based span");
      assertTrue(entity.anchor().endLine() >= entity.anchor().startLine(), entity.id());
    }
  }

  @Test
  void outputIsSortedByIdAndIdenticalAcrossRuns() {
    assertEquals(ids(entities).stream().sorted().toList(), ids(entities));
    assertEquals(json(entities), json(extractOnce()), "two runs over one corpus must agree byte for byte");
  }

  @Test
  void theEntitiesValidateAgainstThePublishedSchema() throws IOException {
    Model model =
        Model.sorted(
            new ExtractorInfo("codegraph-spoon", "0.1.0", Boolean.TRUE),
            root.toString(),
            entities,
            List.of());
    List<Error> errors = validate(new ModelWriter(true).toJson(model));
    assertTrue(errors.isEmpty(), () -> "schema violations: " + errors);
  }

  /** The Java profile declares no `space`, so the key must be absent from the JSON. */
  @Test
  void noEntityCarriesASpaceKey() {
    assertFalse(json(entities).contains("\"space\""));
  }

  // --------------------------------------------------------------- fixtures

  private static List<Entity> extractOnce() {
    Anchors anchors = new Anchors(root);
    return new EntityExtractor(CorpusWhitelist.of(List.of()), anchors).extract(spoonModel);
  }

  private static String json(List<Entity> extracted) {
    Model model =
        Model.sorted(
            new ExtractorInfo("codegraph-spoon", "0.1.0", Boolean.TRUE),
            root.toString(),
            extracted,
            List.of());
    return new ModelWriter(true).toJson(model);
  }

  private static Entity entity(String id) {
    Entity entity = byId.get(id);
    if (entity == null) {
      throw new AssertionError("no entity " + id + " in " + ids(entities));
    }
    return entity;
  }

  private static String kind(String id) {
    return entity(id).kind();
  }

  private static List<String> ids(List<Entity> extracted) {
    return extracted.stream().map(Entity::id).toList();
  }

  private static List<String> orEmpty(List<String> values) {
    return values == null ? List.of() : values;
  }

  private static Set<TraitName> traits(TraitName... values) {
    return values.length == 0 ? EnumSet.noneOf(TraitName.class) : EnumSet.copyOf(List.of(values));
  }

  private static Set<TraitName> minus(Set<TraitName> left, List<TraitName> right) {
    Set<TraitName> difference = new HashSet<>(left);
    difference.removeAll(right);
    return difference;
  }

  private static Set<TraitName> minus(List<TraitName> left, Set<TraitName> right) {
    Set<TraitName> difference = new HashSet<>(left);
    difference.removeAll(right);
    return difference;
  }

  private static void write(String relativePath, String source) throws IOException {
    Path file = root.resolve(relativePath);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
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
    throw new AssertionError("schemas/model.schema.json not found");
  }
}
