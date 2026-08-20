package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.JsonlWriter;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.NaturalKey;
import dev.codegraph.spoon.model.Provenance;
import dev.codegraph.spoon.model.SourceAnchor;
import dev.codegraph.spoon.model.TraitName;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The POJOs are only worth anything if what they serialize satisfies schemas/ —
 * the per-record JSON Schemas plus the container contract, the same files a Go
 * or .NET extractor would validate against. These tests check that, plus the
 * output properties that make a model usable: no {@code null} keys, no rendered
 * id, and a byte stream that does not move between runs.
 */
class JsonlWriterTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  @Test
  void aRepresentativeModelValidatesAgainstThePublishedSchemas() {
    List<String> violations = ExtractorHarness.schemaViolations(write(representativeModel()));
    assertTrue(violations.isEmpty(), () -> "schema violations: " + violations);
  }

  /** {@code "name": null} would violate the trait-key rule the contract states. */
  @Test
  void absentTraitKeysAreOmittedNotNull() {
    String jsonl = write(representativeModel());
    assertFalse(jsonl.contains("null"), () -> "a null reached the model: " + jsonl);
  }

  @Test
  void outputIsByteIdenticalAcrossRuns() {
    assertEquals(write(representativeModel()), write(representativeModel()));
  }

  @Test
  void everyRecordIsOneLineAndTheFileEndsWithExactlyOneNewline() {
    String jsonl = write(representativeModel());
    assertTrue(jsonl.endsWith("}\n"));
    assertFalse(jsonl.endsWith("}\n\n"));
    assertFalse(jsonl.contains("\r"), "CRLF would make output differ between platforms");
    for (String line : jsonl.split("\n")) {
      assertTrue(line.startsWith("{\"t\":"), () -> "a record does not lead with its type: " + line);
    }
  }

  /** Identity travels as (m, s, d) — the file spells out no id at all. */
  @Test
  void noRenderedIdIsWritten() {
    Model model = representativeModel();
    String jsonl = write(model);
    for (Entity entity : model.entities()) {
      assertFalse(jsonl.contains(entity.id()), () -> "the file spells out " + entity.id());
    }
  }

  /** Canonical order (MM-1) IS the surrogate assignment, so it must be imposed. */
  @Test
  void entitiesAreWrittenInNaturalKeyOrderWhateverOrderTheyArriveIn() {
    Model model = representativeModel();
    List<Entity> reversed = new ArrayList<>(model.entities());
    java.util.Collections.reverse(reversed);
    Model shuffled =
        new Model(
            model.schemaVersion(),
            model.lang(),
            model.extractor(),
            model.root(),
            reversed,
            new ArrayList<>(model.edges()));
    assertEquals(write(model), write(shuffled));

    List<NaturalKey> keys = new ArrayList<>();
    for (JsonNode record : records(write(model), "e")) {
      keys.add(NaturalKey.parse(idOf(record, records(write(model), "e"), model.lang())));
    }
    for (int i = 1; i < keys.size(); i++) {
      assertTrue(
          keys.get(i - 1).compareTo(keys.get(i)) < 0,
          "entities are not in canonical natural-key order");
    }
  }

  /** Every reference is an integer; a rendered id in a reference slot is a bug. */
  @Test
  void everyReferenceIsASurrogate() {
    for (JsonNode record : records(write(representativeModel()), "e")) {
      for (String key : List.of("parent", "declaredType", "attachedTo", "m")) {
        if (record.has(key)) {
          assertTrue(record.path(key).isInt(), () -> key + " is not a surrogate: " + record);
        }
      }
      for (String key : List.of("parameters", "localVariables", "definedIn")) {
        record.path(key).forEach(ref -> assertTrue(ref.isInt(), () -> key + " holds " + ref));
      }
    }
    for (JsonNode record : records(write(representativeModel()), "x")) {
      assertTrue(record.path("f").isInt());
      assertTrue(record.path("o").isInt());
      record.path("candidates").forEach(ref -> assertTrue(ref.isInt()));
    }
  }

  /** The trailer is what makes a truncated run detectable. */
  @Test
  void theEofRecordCountsWhatWasWritten() {
    String jsonl = write(representativeModel());
    JsonNode eof = records(jsonl, "eof").get(0);
    assertEquals(records(jsonl, "f").size(), eof.path("counts").path("files").asInt());
    assertEquals(records(jsonl, "e").size(), eof.path("counts").path("entities").asInt());
    assertEquals(records(jsonl, "x").size(), eof.path("counts").path("edges").asInt());
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

  // --------------------------------------------------------------- fixtures

  private static String write(Model model) {
    return new JsonlWriter().toJsonl(model);
  }

  private static List<JsonNode> records(String jsonl, String tag) {
    List<JsonNode> records = new ArrayList<>();
    for (String line : jsonl.split("\n")) {
      try {
        JsonNode record = MAPPER.readTree(line);
        if (tag.equals(record.path("t").asText())) {
          records.add(record);
        }
      } catch (IOException e) {
        throw new AssertionError("unparseable line: " + line, e);
      }
    }
    return records;
  }

  /** Rebuilds a record's rendered id the way any consumer must (schemas/README §2). */
  private static String idOf(JsonNode record, List<JsonNode> entities, String lang) {
    int i = record.path("i").asInt();
    int module = record.path("m").asInt();
    String symbol = record.path("s").asText();
    String modulePath = module == i ? symbol : entities.get(module).path("s").asText();
    StringBuilder id = new StringBuilder(lang).append(':').append(modulePath);
    if (module != i && !symbol.isEmpty()) {
      id.append('/').append(symbol);
    }
    if (record.has("d")) {
      id.append('#').append(record.path("d").asText());
    }
    return id.toString();
  }

  /**
   * Exercises every trait key at least once, plus a stub and five edge kinds —
   * and it is CLOSED. The interchange leaves no choice: a reference travels as a
   * surrogate, so a model that points at something it does not declare cannot be
   * written at all. v1 could write it and let the analyzer complain later.
   */
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
                .marker(TraitName.TWithChildren)
                .build(),
            Entity.builder(type, "class")
                .named("OrderService")
                .type(false)
                .childOf(pkg)
                .marker(TraitName.TWithChildren)
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
            Entity.builder(parameter, "parameter")
                .named("order")
                .typed("java:com.acme.order/Order")
                .childOf(method)
                .marker(TraitName.TStructural)
                .build(),
            Entity.builder(local, "localVariable")
                .named("copy")
                .typed("java:com.acme.order/Order")
                .childOf(method)
                .marker(TraitName.TStructural)
                .build(),
            // Everything the edges and types below point at, degraded as stubs —
            // including the external module, without which `java:java.util/List`
            // has no module entity to name in its key.
            Entity.builder("java:java.util", "package").named("java.util")
                .definedIn(List.of(), true)
                .marker(TraitName.TWithChildren)
                .build(),
            Entity.builder(stub, "class").named("List").type(true).childOf("java:java.util").build(),
            Entity.builder("java:com.acme.order/AbstractService", "class")
                .named("AbstractService")
                .type(true)
                .build(),
            Entity.builder("java:com.acme.order/Invoice", "class").named("Invoice").type(true).build(),
            Entity.builder("java:com.acme.order/Order", "class").named("Order").type(true).build(),
            Entity.builder("java:com.acme.order/TaxCalculator", "class")
                .named("TaxCalculator")
                .type(true)
                .build(),
            Entity.builder("java:com.acme.order/TaxCalculator.apply(double)", "method")
                .named("apply")
                .invocable("apply(double)")
                .childOf("java:com.acme.order/TaxCalculator")
                .build());

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

}
