package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.EdgeKind;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.JsonlWriter;
import dev.codegraph.spoon.model.Provenance;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.visitor.filter.TypeFilter;

/**
 * Pass 3 states what the corpus relates to what. These tests pin the claims that
 * are easy to get wrong and expensive to get wrong: that an unresolved or
 * external target degrades to a type instead of fabricating a member entity,
 * that ambiguity is reported as ambiguity rather than as a fact, that evidence
 * points at the call site, and that two runs produce the same bytes.
 *
 * <p>The corpus is written to disk rather than parsed from a virtual file
 * because anchors are root-relative: the file component of every edge's evidence
 * is part of what is being tested.
 */
class EdgeExtractorTest {

  private static final String ORDER_SERVICE =
      """
      package com.acme.order;

      import java.util.List;
      import com.nonexistent.external.MissingLib;
      import static java.util.Collections.emptyList;

      public class OrderService extends BaseService implements Billable {

        private int count;

        private final List<Order> orders = emptyList();

        public OrderService(String id) {
        }

        @Override
        public Invoice bill(Order order) throws BillingException {
          count++;
          count += 2;
          int copy = count;
          this.count = copy;
          helper();
          order.total();
          Runnable r = () -> count--;
          MissingLib lib = null;
          return null;
        }

        public void charge(Billable target) {
          target.pay();
        }

        @Override
        public void pay() {
        }

        private void helper() {
          helper();
        }
      }
      """;

  private static final String BILLABLE =
      """
      package com.acme.order;

      public interface Billable extends Payable {
        void pay();
      }
      """;

  private static final String PREMIUM =
      """
      package com.acme.order;

      public class PremiumService extends OrderService {

        public PremiumService(String id) {
          super(id);
        }

        @Override
        public void pay() {
        }
      }
      """;

  /** Kinds whose supertypes the language supplies, plus code written outside any invocable. */
  private static final String ZOO =
      """
      package com.acme.zoo;

      public class Zoo {

        static final Zoo INSTANCE = new Zoo();

        static {
          Boot.start();
        }

        enum Kind implements Named {
          BIG, SMALL
        }

        record Pair(String left, String right) implements Named {}

        @interface Marker {}

        interface Named {}

        public Runnable make() {
          Runnable anon = new Runnable() {
            @Override public void run() { Boot.start(); }
          };
          Runnable other = Zoo::describe;
          return anon;
        }

        static void describe() {}
      }
      """;

  private static final String SERVICE_FILE = "com/acme/order/OrderService.java";
  private static final String ZOO_FILE = "com/acme/zoo/Zoo.java";
  private static final String ZOO_TYPE = "java:com.acme.zoo/Zoo";
  private static final String BILL = "java:com.acme.order/OrderService.bill(com.acme.order.Order)";
  private static final String SERVICE = "java:com.acme.order/OrderService";
  private static final String COUNT = "java:com.acme.order/OrderService.count";

  // ------------------------------------------------------------------ import

  @Test
  void resolvedImportsAreDeclaredModuleEdges(@TempDir Path root) throws IOException {
    Edge toJavaUtil =
        at(
            of(extract(root), EdgeKind.IMPORT),
            lineOf(SERVICE_FILE, "import java.util.List;"));

    assertEquals("java:com.acme.order", toJavaUtil.from());
    assertEquals("java:java.util", toJavaUtil.to());
    assertEquals(Provenance.DECLARED, toJavaUtil.provenance());
    assertEquals(SERVICE_FILE, toJavaUtil.anchor().file());
  }

  /**
   * The case that matters for real corpora: a third-party import resolves to
   * nothing in noClasspath mode, so Spoon keeps only its text and the package
   * boundary has to be inferred from it — an inference, hence {@code derived}.
   */
  @Test
  void unresolvedImportsStillProduceAModuleEdge(@TempDir Path root) throws IOException {
    Edge edge =
        single(extract(root), EdgeKind.IMPORT, "java:com.acme.order", "java:com.nonexistent.external");
    assertEquals(Provenance.DERIVED, edge.provenance());
  }

  @Test
  void staticImportsAreFoldedToTheirPackage(@TempDir Path root) throws IOException {
    // `import static java.util.Collections.emptyList` names a member, but the
    // import layer is module-to-module: it lands on java.util like any other.
    List<Edge> imports = of(extract(root), EdgeKind.IMPORT);
    assertTrue(
        imports.stream().anyMatch(e -> e.to().equals("java:java.util")),
        () -> "expected a module edge to java.util, got " + imports);
  }

  // ------------------------------------------- inheritance / implementation

  @Test
  void extendsIsInheritanceAndImplementsIsInterfaceImplementation(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);

    Edge extendsEdge = single(edges, EdgeKind.INHERITANCE, SERVICE, "java:com.acme.order/BaseService");
    assertEquals(Provenance.DECLARED, extendsEdge.provenance());

    Edge implementsEdge =
        single(edges, EdgeKind.INTERFACE_IMPLEMENTATION, SERVICE, "java:com.acme.order/Billable");
    assertEquals(Provenance.DECLARED, implementsEdge.provenance());
  }

  /** An interface never implements: its `extends` list is inheritance between types. */
  @Test
  void interfaceExtendsIsInheritance(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);
    single(edges, EdgeKind.INHERITANCE, "java:com.acme.order/Billable", "java:com.acme.order/Payable");
    assertTrue(
        of(edges, EdgeKind.INTERFACE_IMPLEMENTATION).stream()
            .noneMatch(e -> e.from().equals("java:com.acme.order/Billable")),
        "an interface must not implement");
  }

  // -------------------------------------------------------------- invocation

  @Test
  void aResolvedCallIsADeclaredFactAnchoredAtTheCallSite(@TempDir Path root) throws IOException {
    Edge call = single(extract(root), EdgeKind.INVOCATION, BILL, "java:com.acme.order/OrderService.helper()");
    assertEquals(Provenance.DECLARED, call.provenance());
    assertEquals(null, call.candidates(), "a resolved call is not ambiguous");
    assertEquals(SERVICE_FILE, call.anchor().file());
    assertEquals(
        lineOf(SERVICE_FILE, "    helper();"),
        call.anchor().startLine(),
        "an invocation is evidenced by its call site, not by the method that contains it");
  }

  /**
   * THE stub-discipline rule for members: {@code Order} is a type Spoon invented
   * (it exists nowhere), so {@code Order.total()} is not a corpus entity. The
   * edge is kept — external targets are never dropped — but it lands on the type,
   * which is the only thing a stub can be (METAMODEL.md §6).
   */
  @Test
  void callsToUndeclaredMembersLandOnTheDeclaringType(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);
    single(edges, EdgeKind.INVOCATION, BILL, "java:com.acme.order/Order");
    assertTrue(
        edges.stream().noneMatch(e -> e.to().equals("java:com.acme.order/Order.total()")),
        "a member id nobody declares would become a fabricated class stub in pass 4");
  }

  /**
   * A field initializer is written outside every invocable, so there is no
   * Invocable to be the {@code from} of an invocation. The dependency on the
   * called type is still true and {@code reference} states exactly that much.
   */
  @Test
  void aCallInAFieldInitializerBecomesAReferenceFromTheField(@TempDir Path root) throws IOException {
    Edge edge =
        single(
            extract(root),
            EdgeKind.REFERENCE,
            "java:com.acme.order/OrderService.orders",
            "java:java.util/Collections");
    assertEquals(Provenance.DECLARED, edge.provenance());
  }

  /**
   * A call written inside a local variable's initializer belongs to the method,
   * not to the variable: METAMODEL.md §4 makes invocation Invocable → Invocable,
   * and the innermost declared element is not always an invocable.
   */
  @Test
  void factsInsideALocalDeclarationBelongToTheEnclosingInvocable(@TempDir Path root) throws IOException {
    Edge read = at(accessesTo(extract(root), COUNT), lineOf(SERVICE_FILE, "    int copy = count;"));
    assertEquals(BILL, read.from());
  }

  /**
   * Ambiguity is a fact about knowledge, not about syntax: the corpus declares
   * overrides of {@code Billable.pay()}, so the call names one of several bodies.
   * METAMODEL.md §4 — candidates non-empty iff resolution was ambiguous.
   */
  @Test
  void anOverriddenTargetIsReportedAsDynamicCandidate(@TempDir Path root) throws IOException {
    Edge call =
        single(
            extract(root),
            EdgeKind.INVOCATION,
            "java:com.acme.order/OrderService.charge(com.acme.order.Billable)",
            "java:com.acme.order/Billable.pay()");

    assertEquals(Provenance.DYNAMIC_CANDIDATE, call.provenance());
    assertEquals(
        List.of("java:com.acme.order/OrderService.pay()", "java:com.acme.order/PremiumService.pay()"),
        call.candidates(),
        "both corpus implementations are possible targets; the abstract declaration is not one");
  }

  @Test
  void aPrivateTargetIsNeverAmbiguous(@TempDir Path root) throws IOException {
    Edge call = single(extract(root), EdgeKind.INVOCATION, BILL, "java:com.acme.order/OrderService.helper()");
    assertEquals(Provenance.DECLARED, call.provenance());
  }

  /** METAMODEL.md §4: from ≠ to. Recursion is legal Java, so it is filtered, not an error. */
  @Test
  void recursionIsDroppedRatherThanEmittedAsASelfEdge(@TempDir Path root) throws IOException {
    EdgeExtractor extractor = extractor(root);
    List<Edge> edges = extractor.extract(model(root));

    assertTrue(edges.stream().noneMatch(Edge::selfReference), "no edge may point at its own source");
    assertTrue(
        extractor.droppedSelfReferences() >= 1,
        "helper() calling helper() is a self-edge and must be counted, not silently lost");
  }

  // ------------------------------------------------------------------ access

  @Test
  void aPlainReadIsAReadAndAPlainWriteIsAWrite(@TempDir Path root) throws IOException {
    List<Edge> accesses = accessesTo(extract(root), COUNT);

    Edge read = at(accesses, lineOf(SERVICE_FILE, "    int copy = count;"));
    assertTrue(read.isRead());
    assertFalse(read.isWrite());

    Edge write = at(accesses, lineOf(SERVICE_FILE, "    this.count = copy;"));
    assertFalse(write.isRead());
    assertTrue(write.isWrite());
  }

  /** {@code x++} and {@code x += 2} read the field they write — one edge, both flags. */
  @Test
  void compoundAssignmentAndIncrementAreBothReadAndWrite(@TempDir Path root) throws IOException {
    List<Edge> accesses = accessesTo(extract(root), COUNT);

    for (String statement : List.of("    count++;", "    count += 2;")) {
      Edge edge = at(accesses, lineOf(SERVICE_FILE, statement));
      assertTrue(edge.isRead() && edge.isWrite(), () -> statement + " is a read and a write");
    }
  }

  @Test
  void aLambdaOwnsTheAccessesWrittenInsideIt(@TempDir Path root) throws IOException {
    int line = lineOf(SERVICE_FILE, "    Runnable r = () -> count--;");
    Edge edge =
        accessesTo(extract(root), COUNT).stream()
            .filter(e -> e.anchor().startLine() == line)
            .findFirst()
            .orElseThrow(() -> new AssertionError("no access from the lambda body"));

    assertEquals(SERVICE + "#" + SERVICE_FILE + ":" + line, edge.from());
    assertTrue(edge.isRead() && edge.isWrite());
  }

  // --------------------------------------------------------------- reference

  @Test
  void declaredTypesGenericArgumentsAndThrowsAreReferences(@TempDir Path root) throws IOException {
    List<Edge> references = of(extract(root), EdgeKind.REFERENCE);
    Set<String> fromBill =
        references.stream().filter(e -> e.from().equals(BILL)).map(Edge::to).collect(Collectors.toCollection(TreeSet::new));

    assertTrue(fromBill.contains("java:com.acme.order/Invoice"), () -> "return type missing from " + fromBill);
    assertTrue(fromBill.contains("java:com.acme.order/BillingException"), () -> "throws missing from " + fromBill);
    assertTrue(fromBill.contains("java:java.lang/Override"), () -> "annotation missing from " + fromBill);

    Set<String> fromOrders =
        references.stream()
            .filter(e -> e.from().equals("java:com.acme.order/OrderService.orders"))
            .map(Edge::to)
            .collect(Collectors.toCollection(TreeSet::new));
    assertTrue(fromOrders.contains("java:java.util/List"), () -> "field type missing from " + fromOrders);
    assertTrue(fromOrders.contains("java:com.acme.order/Order"), () -> "type argument missing from " + fromOrders);
  }

  /**
   * Spoon's tree carries the inferred type of every expression, positionless and
   * otherwise indistinguishable from a written one. Claiming those would report
   * dependencies nobody wrote — and would make {@code int} a class.
   */
  @Test
  void primitivesAndInferredExpressionTypesAreNotReferences(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);
    assertTrue(
        edges.stream().noneMatch(e -> e.to().equals("java:<unnamed>/int")),
        "a primitive is not an entity");
    assertTrue(
        edges.stream().noneMatch(e -> e.to().equals("java:<unnamed>/void")),
        "void is not an entity");
    assertTrue(
        edges.stream().noneMatch(e -> e.to().endsWith("/<unknown>")),
        "a target Spoon cannot name states nothing and must not become a node");
  }

  // ------------------------------------------------- kinds and their edges

  /**
   * {@code enum Kind implements Named} extends {@code java.lang.Enum} and a
   * record extends {@code java.lang.Record} without anyone writing it, and Spoon
   * reports both at the declaration's own line. The Java profile settles it:
   * neither kind carries TWithInheritances, so neither states an inheritance.
   */
  @Test
  void languageSuppliedSupertypesAreNotInheritanceClaims(@TempDir Path root) throws IOException {
    List<Edge> inheritance = of(extract(root), EdgeKind.INHERITANCE);

    assertTrue(
        inheritance.stream().noneMatch(e -> e.to().equals("java:java.lang/Enum")),
        () -> "an enum does not declare that it extends Enum: " + inheritance);
    assertTrue(
        inheritance.stream().noneMatch(e -> e.to().equals("java:java.lang/Record")),
        () -> "a record does not declare that it extends Record: " + inheritance);
  }

  @Test
  void enumsAndRecordsStillImplementTheirInterfaces(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);
    single(edges, EdgeKind.INTERFACE_IMPLEMENTATION, ZOO_TYPE + ".Kind", ZOO_TYPE + ".Named");
    single(edges, EdgeKind.INTERFACE_IMPLEMENTATION, ZOO_TYPE + ".Pair", ZOO_TYPE + ".Named");
  }

  /**
   * An anonymous class is an entity of kind {@code lambda}, which carries no
   * TWithImplements: what it says about {@code Runnable} is a reference, and the
   * enclosing method invokes the anonymous class itself.
   */
  @Test
  void anAnonymousClassIsReferencedNotImplemented(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root);
    int line = lineOf(ZOO_FILE, "    Runnable anon = new Runnable() {");
    String anonymous = ZOO_TYPE + "#" + ZOO_FILE + ":" + line;

    single(edges, EdgeKind.REFERENCE, anonymous, "java:java.lang/Runnable");
    single(edges, EdgeKind.INVOCATION, ZOO_TYPE + ".make()", anonymous);
    assertTrue(
        of(edges, EdgeKind.INTERFACE_IMPLEMENTATION).stream().noneMatch(e -> e.from().equals(anonymous)),
        "the lambda kind does not license an implements edge");
  }

  /** A static initializer has no entity of its own: its facts belong to the type. */
  @Test
  void aStaticInitializerBlockIsOwnedByItsType(@TempDir Path root) throws IOException {
    Edge edge = single(extract(root), EdgeKind.REFERENCE, ZOO_TYPE, "java:com.acme.zoo/Boot");
    assertEquals(lineOf(ZOO_FILE, "    Boot.start();"), edge.anchor().startLine());
  }

  @Test
  void methodReferencesAreCallSites(@TempDir Path root) throws IOException {
    Edge edge = single(extract(root), EdgeKind.INVOCATION, ZOO_TYPE + ".make()", ZOO_TYPE + ".describe()");
    assertEquals(lineOf(ZOO_FILE, "    Runnable other = Zoo::describe;"), edge.anchor().startLine());
  }

  // ----------------------------------------------------------- whole-output

  @Test
  void everyEdgeCarriesProvenanceAnchoredEvidenceAndALicensedKind(@TempDir Path root) throws IOException {
    Set<EdgeKind> licensed =
        Set.of(
            EdgeKind.IMPORT,
            EdgeKind.INHERITANCE,
            EdgeKind.INTERFACE_IMPLEMENTATION,
            EdgeKind.INVOCATION,
            EdgeKind.ACCESS,
            EdgeKind.REFERENCE);

    for (Edge edge : extract(root)) {
      assertTrue(licensed.contains(edge.edge()), () -> "the Java profile does not license " + edge.edge());
      assertTrue(edge.provenance() != null, () -> "no provenance on " + edge);
      assertTrue(edge.anchor() != null && edge.anchor().startLine() >= 1, () -> "no evidence for " + edge);
      assertTrue(
          edge.candidates() == null || edge.provenance() == Provenance.DYNAMIC_CANDIDATE,
          () -> "candidates are for ambiguous dispatch only: " + edge);
    }
  }

  /**
   * Closure (CLAUDE.md invariant 10) minus the stub pass: {@code from} must
   * always be an entity pass 2 emitted, or pass 4 would synthesize a class stub
   * named after a method to receive it.
   */
  @Test
  void everyEdgeStartsAtADeclaredEntity(@TempDir Path root) throws IOException {
    CtModel model = model(root);
    CorpusWhitelist whitelist = whitelistOf(model, root);
    for (Edge edge : new EdgeExtractor(whitelist, new Anchors(root)).extract(model)) {
      assertTrue(
          whitelist.declares(edge.from()),
          () -> "edge from an id the corpus never declared: " + edge.from());
    }
  }

  @Test
  void twoRunsProduceTheSameEdgesInTheSameOrder(@TempDir Path root) throws IOException {
    assertEquals(edgeLines(extract(root)), edgeLines(extract(root)));
  }

  /**
   * Edges are validated inside a CLOSED model: every endpoint is a surrogate, so
   * the entity and stub passes have to run too. Serializing edges over an empty
   * entity list is not a smaller version of the real thing — it is unwritable.
   */
  @Test
  void theEmittedEdgesValidateAgainstThePublishedSchema(@TempDir Path root) throws IOException {
    CtModel spoon = model(root);
    CorpusWhitelist whitelist = whitelistOf(spoon, root);
    Anchors anchors = new Anchors(root);
    List<Entity> declared = new EntityExtractor(whitelist, anchors).extract(spoon);
    List<Edge> edges = new EdgeExtractor(whitelist, anchors).extract(spoon);

    Set<String> known = new TreeSet<>();
    declared.forEach(entity -> known.add(entity.id()));
    Set<String> referenced = new TreeSet<>();
    for (Entity entity : declared) {
      for (String id : new String[] {entity.declaredType(), entity.parent(), entity.attachedTo()}) {
        if (id != null) {
          referenced.add(id);
        }
      }
    }
    for (Edge edge : edges) {
      referenced.add(edge.from());
      referenced.add(edge.to());
      if (edge.candidates() != null) {
        referenced.addAll(edge.candidates());
      }
    }
    referenced.removeAll(known);

    List<Entity> entities = new java.util.ArrayList<>(declared);
    entities.addAll(new StubSynthesizer().synthesize(referenced, whitelist));
    entities.forEach(entity -> known.add(entity.id()));
    List<Edge> closed =
        edges.stream()
            .filter(edge -> !edge.selfReference())
            .filter(edge -> known.contains(edge.from()) && known.contains(edge.to()))
            .toList();

    Model model =
        Model.sorted(
            new ExtractorInfo("codegraph-spoon", "0.2.0", Boolean.TRUE),
            root.toString(),
            entities,
            closed);

    List<String> violations = ExtractorHarness.schemaViolations(new JsonlWriter().toJsonl(model));
    assertTrue(violations.isEmpty(), () -> "schema violations: " + violations);
    assertFalse(closed.isEmpty(), "the corpus produced no writable edges at all");
  }

  /**
   * Lombok expansions are the one case where an element nobody wrote is a member
   * the corpus really has. Spoon marks them implicit exactly as it marks its own
   * artifacts, so the discriminator is the {@code lombok.*} annotation on the
   * enclosing type — modelled here by making a real call implicit and annotating
   * its class, because Lombok's expansion is invisible without its processor.
   */
  @Test
  void implicitElementsOfALombokAnnotatedTypeAreGenerated(@TempDir Path root) throws IOException {
    CtModel model = model(root);
    CtType<?> service = type(model, "OrderService");
    CtInvocation<?> call = invocationOf(model, "helper", "bill");
    call.setImplicit(true);

    List<Edge> withoutLombok = new EdgeExtractor(whitelistOf(model, root), new Anchors(root)).extract(model);
    assertTrue(
        withoutLombok.stream().noneMatch(e -> e.to().equals("java:com.acme.order/OrderService.helper()")),
        "an implicit element of an ordinary type is a Spoon artifact and states nothing");

    annotateWithLombok(service);
    List<Edge> withLombok = new EdgeExtractor(whitelistOf(model, root), new Anchors(root)).extract(model);

    Edge generated =
        withLombok.stream()
            .filter(e -> e.to().equals("java:com.acme.order/OrderService.helper()"))
            .findFirst()
            .orElseThrow(() -> new AssertionError("a visible Lombok expansion must still be an edge"));
    assertEquals(Provenance.GENERATED, generated.provenance());
  }

  // -------------------------------------------------------------- fixtures

  private static List<Edge> extract(Path root) throws IOException {
    CtModel model = model(root);
    return new EdgeExtractor(whitelistOf(model, root), new Anchors(root)).extract(model);
  }

  private static EdgeExtractor extractor(Path root) throws IOException {
    CtModel model = model(root);
    return new EdgeExtractor(whitelistOf(model, root), new Anchors(root));
  }

  private static CtModel model(Path root) throws IOException {
    write(root, SERVICE_FILE, ORDER_SERVICE);
    write(root, "com/acme/order/Billable.java", BILLABLE);
    write(root, "com/acme/order/PremiumService.java", PREMIUM);
    write(root, ZOO_FILE, ZOO);

    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(root.toString());
    return launcher.buildModel();
  }

  private static void write(Path root, String relative, String source) throws IOException {
    Path file = root.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }

  /**
   * A stand-in for pass 1, built with the same {@link EntityIds} the real
   * whitelist will use. {@code CorpusWhitelist.build} is another agent's seam and
   * still throws, but pass 3's behaviour is defined entirely by what the
   * whitelist answers, so it has to be a faithful one.
   */
  private static CorpusWhitelist whitelistOf(CtModel model, Path root) {
    Anchors anchors = new Anchors(root);
    Set<String> ids = new TreeSet<>();
    for (CtType<?> type : model.getElements(new TypeFilter<CtType<?>>(CtType.class))) {
      if (type instanceof CtTypeParameter) {
        continue;
      }
      String typeId =
          type instanceof CtClass<?> clazz && clazz.isAnonymous()
              ? EntityIds.forAnonymousClass(clazz, anchors.relativeFile(type))
              : EntityIds.forType(type);
      ids.add(typeId);
      ids.add(EntityIds.packageIdOfTypeId(typeId));
      for (CtMethod<?> method : type.getMethods()) {
        ids.add(EntityIds.forMethodIn(typeId, method));
        members(ids, EntityIds.forMethodIn(typeId, method), method);
      }
      if (type instanceof CtClass<?> clazz) {
        for (CtConstructor<?> constructor : clazz.getConstructors()) {
          ids.add(EntityIds.forConstructorIn(typeId, constructor));
          members(ids, EntityIds.forConstructorIn(typeId, constructor), constructor);
        }
      }
      for (CtField<?> field : type.getFields()) {
        ids.add(EntityIds.forFieldIn(typeId, field));
      }
    }
    for (CtLambda<?> lambda : model.getElements(new TypeFilter<CtLambda<?>>(CtLambda.class))) {
      String lambdaId = EntityIds.forLambda(lambda, anchors.relativeFile(lambda));
      ids.add(lambdaId);
      members(ids, lambdaId, lambda);
    }
    return CorpusWhitelist.of(ids);
  }

  private static void members(Set<String> ids, String executableId, CtExecutable<?> executable) {
    for (CtParameter<?> parameter : executable.getParameters()) {
      ids.add(EntityIds.forParameterOf(executableId, parameter.getSimpleName()));
    }
    for (CtLocalVariable<?> local : executable.getElements(new TypeFilter<>(CtLocalVariable.class))) {
      ids.add(
          EntityIds.forLocalVariableOf(executableId, local.getSimpleName(), local.getPosition().getLine()));
    }
  }

  private static CtType<?> type(CtModel model, String simpleName) {
    return model.getAllTypes().stream()
        .filter(t -> t.getSimpleName().equals(simpleName))
        .findFirst()
        .orElseThrow(() -> new AssertionError("no such type: " + simpleName));
  }

  private static CtInvocation<?> invocationOf(CtModel model, String called, String inside) {
    return model.getElements(new TypeFilter<CtInvocation<?>>(CtInvocation.class)).stream()
        .filter(i -> called.equals(i.getExecutable().getSimpleName()))
        .filter(i -> {
          CtMethod<?> enclosing = i.getParent(CtMethod.class);
          return enclosing != null && enclosing.getSimpleName().equals(inside);
        })
        .findFirst()
        .orElseThrow(() -> new AssertionError("no call to " + called + " inside " + inside));
  }

  /** Lombok is not on the test classpath; only the annotation's name matters here. */
  @SuppressWarnings({"unchecked", "rawtypes"})
  private static void annotateWithLombok(CtType<?> type) {
    CtTypeReference reference = type.getFactory().Type().createReference("lombok.Data");
    type.getFactory().Annotation().annotate(type, reference);
  }

  private static List<Edge> of(List<Edge> edges, EdgeKind kind) {
    return edges.stream().filter(e -> e.edge() == kind).toList();
  }

  private static Edge single(List<Edge> edges, EdgeKind kind, String from, String to) {
    List<Edge> matches =
        edges.stream().filter(e -> e.edge() == kind && e.from().equals(from) && e.to().equals(to)).toList();
    if (matches.size() != 1) {
      throw new AssertionError(
          "expected exactly one " + kind + " " + from + " -> " + to + ", got " + matches.size() + " in\n"
              + edgeLines(edges));
    }
    return matches.get(0);
  }

  private static List<Edge> accessesTo(List<Edge> edges, String field) {
    return edges.stream().filter(e -> e.edge() == EdgeKind.ACCESS && e.to().equals(field)).toList();
  }

  private static Edge at(List<Edge> edges, int line) {
    return edges.stream()
        .filter(e -> e.anchor().startLine() == line)
        .findFirst()
        .orElseThrow(() -> new AssertionError("no edge anchored at line " + line + " in\n" + edgeLines(edges)));
  }

  /** 1-based line of the first source line equal to the given text, for anchor assertions. */
  private static int lineOf(String file, String text) {
    String source =
        switch (file) {
          case SERVICE_FILE -> ORDER_SERVICE;
          case ZOO_FILE -> ZOO;
          default -> throw new AssertionError("unknown fixture file: " + file);
        };
    List<String> lines = List.of(source.split("\n", -1));
    for (int i = 0; i < lines.size(); i++) {
      if (lines.get(i).equals(text)) {
        return i + 1;
      }
    }
    throw new AssertionError("no line [" + text + "] in " + file);
  }

  private static String edgeLines(List<Edge> edges) {
    List<String> lines = new ArrayList<>(edges.size());
    for (Edge edge : edges) {
      lines.add(
          edge.edge().json()
              + " "
              + edge.from()
              + " -> "
              + edge.to()
              + " ["
              + edge.provenance().json()
              + " "
              + edge.anchor().file()
              + ":"
              + edge.anchor().startLine()
              + (edge.candidates() == null ? "" : " candidates=" + edge.candidates())
              + (edge.isRead() == null ? "" : " read=" + edge.isRead() + " write=" + edge.isWrite())
              + "]");
    }
    return String.join("\n", lines);
  }

}
