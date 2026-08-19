package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * THE ACCEPTANCE GATE. The extractor runs over fixtures/java and its output is
 * validated against schemas/model.schema.json — the committed, generated,
 * cross-language contract, and the only thing this extractor is allowed to know
 * about the metamodel (CLAUDE.md, "Extractors contain no metamodel
 * intelligence").
 *
 * <p>Nothing here reaches into {@code @codegraph/core}. That is the point: this
 * test is the executable form of "an extractor in any language can self-validate
 * using only the published schema". A Go or .NET extractor would reproduce it
 * verbatim with its own runner.
 *
 * <p>What the schema does NOT cover, deliberately (PLAN.md §4.5): which kinds
 * exist and which trait compositions each kind licenses. That is profile-aware
 * and lives in {@link EntityTraitConformanceTest}.
 */
class ModelSchemaValidationTest {

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.json")).succeeded();
  }

  @Test
  void theFixtureModelSatisfiesThePublishedSchema() {
    Schema schema =
        SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
            .getSchema(ExtractorHarness.publishedSchema(), InputFormat.JSON);

    List<Error> errors = schema.validate(run.json(), InputFormat.JSON);

    // Every message, not just the first: a schema violation must be diagnosable
    // from the failure text alone, without attaching a debugger to the run.
    assertTrue(
        errors.isEmpty(),
        () ->
            errors.size()
                + " schema violation(s) in "
                + run.modelFile()
                + ":\n"
                + errors.stream().map(error -> "  - " + error).collect(Collectors.joining("\n")));
  }

  /** A model with no entities validates vacuously; the gate must not pass on nothing. */
  @Test
  void theFixtureModelIsNotVacuouslyValid() {
    assertTrue(run.entities().size() >= 20, () -> "suspiciously few entities: " + run.entities().size());
    assertTrue(run.edges().size() >= 10, () -> "suspiciously few edges: " + run.edges().size());
  }

  @Test
  void theEnvelopeNamesTheContractAndTheProfile() {
    assertEquals("1.0.0", run.model().path("schemaVersion").asText());
    assertEquals("java", run.model().path("lang").asText());
    assertEquals("codegraph-spoon", run.model().path("extractor").path("name").asText());
    assertTrue(run.model().path("extractor").path("noClasspath").asBoolean());
  }

  /** stdout stays free for piping; the summary belongs on stderr (PLAN.md §5.3). */
  @Test
  void nothingIsWrittenToStdout() {
    assertTrue(run.stdout().isBlank(), () -> "stdout was not empty: " + run.stdout());
  }
}
