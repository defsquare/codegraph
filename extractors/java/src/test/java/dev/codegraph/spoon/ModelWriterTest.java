package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.ModelWriter;
import dev.codegraph.spoon.model.Provenance;
import dev.codegraph.spoon.model.SourceAnchor;
import dev.codegraph.spoon.model.TraitName;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The POJOs are only worth anything if what they serialize satisfies
 * schemas/model.schema.json — the whole contract, and the same file a Go or .NET
 * extractor would validate against. These tests check that, plus the two output
 * properties that make a model diffable: no {@code null} keys, and a byte stream
 * that does not move between runs.
 */
class ModelWriterTest {

  @Test
  void aRepresentativeModelValidatesAgainstThePublishedSchema() throws IOException {
    List<Error> errors = validate(new ModelWriter(true).toJson(representativeModel()));
    assertTrue(errors.isEmpty(), () -> "schema violations: " + errors);
  }

  /** {@code "name": null} would violate the trait-key rule the schema states. */
  @Test
  void absentTraitKeysAreOmittedNotNull() {
    String json = new ModelWriter(false).toJson(representativeModel());
    assertFalse(json.contains("null"), () -> "a null reached the model: " + json);
  }

  @Test
  void outputIsByteIdenticalAcrossRuns() {
    assertEquals(
        new ModelWriter(true).toJson(representativeModel()),
        new ModelWriter(true).toJson(representativeModel()));
  }

  @Test
  void outputEndsWithExactlyOneNewlineAndUsesLfIndentation() {
    String json = new ModelWriter(true).toJson(representativeModel());
    assertTrue(json.endsWith("}\n"));
    assertFalse(json.endsWith("}\n\n"));
    assertFalse(json.contains("\r"), "CRLF would make output differ between platforms");
  }

  @Test
  void entitiesAreSortedByIdAndEdgesDeterministically() {
    Model model = representativeModel();
    List<String> ids = model.entities().stream().map(Entity::id).toList();
    assertEquals(ids.stream().sorted().toList(), ids);
    assertEquals(model.edges().stream().sorted(Edge.DETERMINISTIC_ORDER).toList(), model.edges());
  }

  /** The builder is the guard: a trait cannot be declared without its key. */
  @Test
  void keyContributingTraitsCannotBeAddedAsMarkers() {
    Entity.Builder builder = Entity.builder("java:com.acme/X", "class");
    assertThrows(IllegalArgumentException.class, () -> builder.marker(TraitName.TNamed));
    assertThrows(IllegalArgumentException.class, () -> builder.marker(TraitName.TInvocable));
    builder.marker(TraitName.TWithInheritances);
  }

  @Test
  void anchorSpansAreOneBased() {
    assertThrows(IllegalArgumentException.class, () -> SourceAnchor.of("A.java", 0, 3));
  }

  @Test
  void everyEdgeNeedsProvenanceAndAnAnchor() {
    assertThrows(
        IllegalArgumentException.class,
        () -> Edge.reference("java:p/A", "java:p/B", Provenance.DECLARED, null));
    assertThrows(
        IllegalArgumentException.class,
        () -> Edge.reference("java:p/A", "java:p/B", null, SourceAnchor.of("A.java", 1, 1)));
  }

  /** Exercises every trait key at least once, plus a stub and five edge kinds. */
  private static Model representativeModel() {
    SourceAnchor anchor = SourceAnchor.of("com/acme/order/OrderService.java", 15, 22);
    String pkg = "java:com.acme.order";
    String type = "java:com.acme.order/OrderService";
    String method = "java:com.acme.order/OrderService.bill(com.acme.order.Order)";
    String parameter = method + "#param:order";
    String local = method + "#local:copy:16";
    String field = "java:com.acme.order/OrderService.count";
    String stub = "java:java.util/List";

    List<Entity> entities =
        List.of(
            Entity.builder(pkg, "package")
                .named("com.acme.order")
                .definedIn(List.of("com/acme/order/OrderService.java"), false)
                .withChildren(List.of(type))
                .build(),
            Entity.builder(type, "class")
                .named("OrderService")
                .type(false)
                .childOf(pkg)
                .withChildren(List.of(method, field))
                .anchoredAt(SourceAnchor.of("com/acme/order/OrderService.java", 5, 40))
                .commented(List.of("Bills orders."))
                .markers(TraitName.TWithInheritances, TraitName.TWithImplements)
                .build(),
            Entity.builder(method, "method")
                .named("bill")
                .invocable("bill(com.acme.order.Order)")
                .typed("java:com.acme.order/Invoice")
                .childOf(type)
                .withParameters(List.of(parameter))
                .withLocalVariables(List.of(local))
                .anchoredAt(anchor)
                .markers(TraitName.TWithInvocations, TraitName.TWithAccesses)
                .build(),
            Entity.builder(field, "attribute")
                .named("count")
                .typed(null)
                .childOf(type)
                .anchoredAt(SourceAnchor.of("com/acme/order/OrderService.java", 7, 7))
                .marker(TraitName.TStructural)
                .build(),
            Entity.builder(stub, "class").named("List").type(true).build());

    List<Edge> edges =
        List.of(
            Edge.importEdge(pkg, "java:java.util", Provenance.DECLARED, anchor),
            Edge.inheritance(type, "java:com.acme.order/AbstractService", Provenance.DECLARED, anchor),
            Edge.interfaceImplementation(type, stub, Provenance.DECLARED, anchor),
            Edge.invocation(
                method,
                "java:com.acme.order/TaxCalculator.apply(double)",
                Provenance.DYNAMIC_CANDIDATE,
                anchor,
                List.of("java:com.acme.order/TaxCalculator.apply(double)")),
            Edge.access(method, field, Provenance.DECLARED, anchor, true, false),
            Edge.reference(method, stub, Provenance.DECLARED, anchor));

    return Model.sorted(
        new ExtractorInfo("codegraph-spoon", "0.1.0", Boolean.TRUE), "/corpus", entities, edges);
  }

  private static List<Error> validate(String modelJson) throws IOException {
    Schema schema =
        SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
            .getSchema(Files.readString(schemaFile()), InputFormat.JSON);
    return schema.validate(modelJson, InputFormat.JSON);
  }

  /** schemas/ lives at the repo root; the test must not care how deep it runs. */
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
