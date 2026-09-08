package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import dev.codegraph.spoon.model.NaturalKey;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Two runs over one corpus must produce a byte-identical model.jsonl (PLAN.md §8).
 *
 * <p>This is not a nicety. A model that shuffles between runs is
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
    assertEquals(first.json(), second.json(), "model.jsonl is not reproducible across runs");
    assertArrayEquals(first.bytes(), second.bytes(), "model.jsonl differs in bytes but not in text");
  }

  /**
   * The model must not differ by the MACHINE that produced it, only by the corpus.
   *
   * <p>Spoon reassembles a javadoc with {@code System.lineSeparator()}, so the
   * same fixture emitted {@code \r\n} inside every comment on a Windows runner
   * and {@code \n} here — 18 escapes' worth, and the cross-OS gate went red on
   * "char 8026, line 49" with nothing wrong in the code. Source line endings were
   * never the cause: Spoon normalises a CRLF file to LF, and .gitattributes
   * checks the fixtures out as LF everywhere.
   *
   * <p>Forking with {@code -Dline.separator} is what makes that reachable from a
   * Linux test at all: {@code System.lineSeparator()} is fixed when the JVM
   * starts, so no in-process test can move it.
   */
  @Test
  void thePlatformLineSeparatorNeverReachesTheModel() {
    ExtractorHarness.Run windowsLike =
        ExtractorHarness.runWith(
                List.of("-Dline.separator=\r\n"),
                ExtractorHarness.fixtureCorpus(),
                outputDirectory.resolve("crlf.json"))
            .succeeded();

    assertFalse(
        windowsLike.json().contains("\\r"),
        "a carriage return reached the model — it would differ on Windows only");
    assertEquals(
        first.json(),
        windowsLike.json(),
        "the model changed with the platform's line separator");
  }

  /**
   * Canonical order (MM-1) is by NATURAL KEY, not by rendered id: once `/` and
   * `.` are ordinary characters the two orders differ, and the key's is the one
   * that assigns surrogates. Restated over the emitted records, because that is
   * where a skipped sort would show.
   */
  @Test
  void entitiesAreInCanonicalNaturalKeyOrderAndUnique() {
    List<NaturalKey> keys =
        first.entities().stream().map(e -> NaturalKey.parse(e.path("id").asText())).toList();
    assertEquals(keys.stream().sorted().toList(), keys, "entities are not in canonical order");
    assertEquals(keys.stream().distinct().count(), keys.size(), "a natural key was emitted twice");
  }

  /**
   * Edges follow their endpoints' surrogates, so an entity's outgoing edges stay
   * together and a change to one entity is a local diff.
   */
  @Test
  void edgesFollowTheirEndpointsSurrogates() {
    List<JsonNode> records = first.recordsOfType("x");
    for (int i = 1; i < records.size(); i++) {
      JsonNode previous = records.get(i - 1);
      JsonNode current = records.get(i);
      int order =
          Integer.compare(previous.path("f").asInt(), current.path("f").asInt()) != 0
              ? Integer.compare(previous.path("f").asInt(), current.path("f").asInt())
              : Integer.compare(previous.path("o").asInt(), current.path("o").asInt());
      assertTrue(order <= 0, "edges are not ordered by (from, to) surrogate");
    }
  }
}
