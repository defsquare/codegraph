package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Two runs over one corpus must produce byte-identical model.json (PLAN.md §8).
 *
 * <p>This is not a nicety. A model.json that shuffles between runs is
 * unreviewable in git: every regeneration is a whole-file diff and a real change
 * becomes invisible inside the noise. The failure mode this catches is always the
 * same — some {@code HashMap}/{@code HashSet} iteration order leaking into the
 * output, either as ordering or as "which of two equal candidates won".
 *
 * <p>Two SEPARATE processes, not two calls in one JVM: within a single JVM a
 * {@code HashSet<String>} iterates identically every time, so an in-process
 * comparison would pass on exactly the code this test exists to reject. Fresh
 * JVMs vary identity hash codes, and with them any ordering derived from them.
 */
class DeterminismTest {

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run first;
  private static ExtractorHarness.Run second;

  @BeforeAll
  static void extractTwice() {
    first = ExtractorHarness.runOnFixtures(outputDirectory.resolve("first.json")).succeeded();
    second = ExtractorHarness.runOnFixtures(outputDirectory.resolve("second.json")).succeeded();
  }

  @Test
  void twoRunsOverTheSameCorpusAreByteIdentical() {
    // Text first: on failure the diff is readable, rather than "arrays differ at [4711]".
    assertEquals(first.json(), second.json(), "model.json is not reproducible across runs");
    assertArrayEquals(first.bytes(), second.bytes(), "model.json differs in bytes but not in text");
  }

  @Test
  void entitiesAreSortedByIdAndUnique() {
    List<String> ids = first.entities().stream().map(entity -> entity.path("id").asText()).toList();
    assertEquals(ids.stream().sorted().toList(), ids, "entities are not sorted by id");
    assertEquals(ids.stream().distinct().count(), ids.size(), "an entity id was emitted twice");
  }

  /**
   * The emitted order must equal Edge.DETERMINISTIC_ORDER — (edge, from, to,
   * anchor.file, span, provenance) — restated over the serialized form, because
   * the serialized form is where a skipped sort would show.
   */
  @Test
  void edgesAreInTheDeterministicOrder() {
    List<JsonNode> edges = first.edges();
    assertEquals(
        edges.stream().sorted(DETERMINISTIC_ORDER).map(JsonNode::toString).toList(),
        edges.stream().map(JsonNode::toString).toList(),
        "edges are not in the deterministic order");
  }

  private static final Comparator<JsonNode> DETERMINISTIC_ORDER =
      Comparator.comparing((JsonNode e) -> e.path("edge").asText())
          .thenComparing(e -> e.path("from").asText())
          .thenComparing(e -> e.path("to").asText())
          .thenComparing(e -> e.path("anchor").path("file").asText())
          .thenComparingInt(e -> e.path("anchor").path("span").path(0).asInt())
          .thenComparingInt(e -> e.path("anchor").path("span").path(1).asInt())
          .thenComparing(e -> e.path("provenance").asText());
}
