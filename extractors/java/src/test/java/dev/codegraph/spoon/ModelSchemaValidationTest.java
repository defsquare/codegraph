package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * THE ACCEPTANCE GATE. The extractor runs over fixtures/java and every line of
 * its output is validated against the per-record schema its {@code t} selects —
 * the committed, generated, cross-language contract, and the only thing this
 * extractor is allowed to know about the metamodel (CLAUDE.md, "Extractors
 * contain no metamodel intelligence").
 *
 * <p>Nothing here reaches into {@code @codegraph/core}. That is the point: this
 * test is the executable form of "an extractor in any language can self-validate
 * using only the published schema". A Go or .NET extractor would reproduce it
 * verbatim with its own runner.
 *
 * <p>What the schemas do NOT cover: which kinds exist and which trait
 * compositions each kind licenses — profile-aware, so it lives in
 * {@link EntityTraitConformanceTest} — and everything only a SEQUENCE of lines
 * can express (section order, closure, eof counts), which the harness's decoder
 * checks as it reads, exactly as schemas/README.md tells any consumer to.
 */
class ModelSchemaValidationTest {

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.jsonl")).succeeded();
  }

  @Test
  void everyLineSatisfiesThePublishedSchemaForItsRecordType() {
    List<String> violations = ExtractorHarness.schemaViolations(run.json());

    // Every message, not just the first: a schema violation must be diagnosable
    // from the failure text alone, without attaching a debugger to the run.
    assertTrue(
        violations.isEmpty(),
        () ->
            violations.size()
                + " schema violation(s) in "
                + run.modelFile()
                + ":\n"
                + violations.stream().map(v -> "  - " + v).collect(Collectors.joining("\n")));
  }

  /** The container contract: one header first, one eof last, sections in order. */
  @Test
  void theFileIsShapedLikeTheContainerContractSays() {
    List<String> tags = run.records().stream().map(record -> record.path("t").asText()).toList();
    assertEquals("header", tags.get(0));
    assertEquals("eof", tags.get(tags.size() - 1));
    assertEquals(1, tags.stream().filter("header"::equals).count());
    assertEquals(1, tags.stream().filter("eof"::equals).count());

    List<String> order = List.of("header", "f", "e", "x", "eof");
    int section = 0;
    for (String tag : tags) {
      int rank = order.indexOf(tag);
      assertTrue(rank >= section, () -> "record \"" + tag + "\" appears after its section closed");
      section = rank;
    }
  }

  /** The claim the encoding rests on: identity travels as (m, s, d). */
  @Test
  void noRenderedIdIsWrittenToTheFile() {
    String text = run.json();
    for (var entity : run.entities()) {
      String id = entity.path("id").asText();
      assertFalse(text.contains(id), () -> "the file spells out the rendered id " + id);
    }
  }

  /** Surrogates are dense and ascending, or a reference means nothing. */
  @Test
  void surrogatesAreDenseAndAscending() {
    List<com.fasterxml.jackson.databind.JsonNode> entities = run.recordsOfType("e");
    for (int i = 0; i < entities.size(); i++) {
      assertEquals(i, entities.get(i).path("i").asInt(), "entity surrogate " + i);
      assertTrue(
          entities.get(i).path("m").asInt() <= i,
          "an entity's module must be declared before it, so a reader never needs lookahead");
    }
    List<com.fasterxml.jackson.databind.JsonNode> files = run.recordsOfType("f");
    for (int i = 0; i < files.size(); i++) {
      assertEquals(i, files.get(i).path("i").asInt(), "file index " + i);
    }
  }

  /** A model with no entities validates vacuously; the gate must not pass on nothing. */
  @Test
  void theFixtureModelIsNotVacuouslyValid() {
    assertTrue(run.entities().size() >= 20, () -> "suspiciously few entities: " + run.entities().size());
    assertTrue(run.edges().size() >= 10, () -> "suspiciously few edges: " + run.edges().size());
  }

  @Test
  void theHeaderNamesTheContractAndTheProfile() {
    assertEquals("1.0.0", run.header().path("schemaVersion").asText());
    assertEquals("java", run.header().path("lang").asText());
    assertEquals("codegraph-spoon", run.header().path("extractor").path("name").asText());
    assertTrue(run.header().path("extractor").path("noClasspath").asBoolean());
  }

  /** MM-3: a model declares the vocabularies its records index into. */
  @Test
  void theHeaderDeclaresTheVocabulariesTheRecordsUse() {
    var dict = run.header().path("dict");
    for (String vocabulary : List.of("kinds", "traits", "edges", "provenance")) {
      assertTrue(dict.path(vocabulary).size() > 0, () -> "empty dictionary: " + vocabulary);
    }
    for (var entity : run.recordsOfType("e")) {
      assertTrue(entity.path("k").asInt() < dict.path("kinds").size());
      entity.path("tr").forEach(ref -> assertTrue(ref.asInt() < dict.path("traits").size()));
    }
  }

  /**
   * No diagnostic reaches stdout: the summary, the warnings and the progress
   * belong on stderr (PLAN.md §5.3). stdout carries only the completion notice —
   * its two lines are {@link CompletionNoticeTest}'s subject, not this one's.
   */
  @Test
  void noDiagnosticIsWrittenToStdout() {
    List<String> unexpected =
        run.stdout()
            .lines()
            .filter(line -> !line.startsWith("source: ") && !line.startsWith("model:  "))
            .toList();

    assertTrue(unexpected.isEmpty(), () -> "diagnostics leaked to stdout: " + unexpected);
  }
}
