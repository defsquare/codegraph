package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The committed snapshot: {@code fixtures/java/expected/model.json} is what the
 * extractor CLAIMS about a corpus a reviewer can read in full. Pretty-printed and
 * deterministically sorted so that any change to the extractor shows up as a
 * reviewable diff rather than as a number moving in a summary line.
 *
 * <p>This is documentation with a test attached. When it fails, the question is
 * never "how do I make it green" but "is the new output better?" — and if it is,
 * the diff is the changelog for the model.
 *
 * <p><b>The {@code root} field is normalised.</b> {@code Main} writes the absolute
 * path it was pointed at, which is correct at runtime (anchors are relative to it)
 * and useless in a committed file — it would differ on every machine. Both the
 * regeneration and the comparison rewrite it to {@link #CANONICAL_ROOT}; nothing
 * else in the model is touched, so the snapshot stays byte-exact everywhere else.
 */
class SnapshotTest {

  /** Repo-relative stand-in for the machine-specific absolute root. */
  private static final String CANONICAL_ROOT = "fixtures/java/src";

  /** {@code ./mvnw -B test -Dcodegraph.updateSnapshot=true} rewrites the file. */
  private static final String UPDATE_PROPERTY = "codegraph.updateSnapshot";

  private static final String REGENERATE =
      """

      To regenerate the snapshot DELIBERATELY (read the diff before committing it):

          cd extractors/java
          ./mvnw -B test -Dtest=SnapshotTest -Dcodegraph.updateSnapshot=true

      or by hand:

          java -jar target/codegraph-java.jar \\
              --src ../../fixtures/java/src --out ../../fixtures/java/expected/model.json --pretty
          # then replace the absolute "root" with "fixtures/java/src"

      A diff here is the extractor changing what it claims about known code. That is
      sometimes right — but it is never routine, and it is never a formality.
      """;

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;
  private static Path snapshotFile;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.json")).succeeded();
    snapshotFile = ExtractorHarness.repoRoot().resolve("fixtures/java/expected/model.json");
  }

  @Test
  void theExtractorReproducesTheCommittedSnapshot() {
    String actual = normalised(run.json());

    if (Boolean.getBoolean(UPDATE_PROPERTY)) {
      write(snapshotFile, actual);
      System.err.println("snapshot rewritten: " + snapshotFile + " — review the diff before committing");
      return;
    }

    assertTrue(
        Files.isRegularFile(snapshotFile),
        () -> "the committed snapshot is missing: " + snapshotFile + REGENERATE);

    String expected = ExtractorHarness.read(snapshotFile);
    if (!expected.equals(actual)) {
      assertEquals(expected, actual, firstDifference(expected, actual) + REGENERATE);
    }
  }

  /**
   * The snapshot is the pretty, sorted form PLAN.md §5.3 asks for — a reviewer must
   * be able to read it. A single-line model would technically round-trip and be
   * worthless in a diff, so the shape itself is asserted.
   */
  @Test
  void theSnapshotIsReviewable() {
    String snapshot = ExtractorHarness.read(snapshotFile);
    assertTrue(snapshot.lines().count() > 100, "the snapshot is not pretty-printed — a diff would be one line");
    assertTrue(snapshot.contains("\"root\" : \"" + CANONICAL_ROOT + "\""), "the snapshot's root is not normalised");
  }

  /** Replaces the machine-specific absolute root; everything else is untouched. */
  private static String normalised(String json) {
    String root = ExtractorHarness.fixtureCorpus().toString();
    return json.replace("\"" + root + "\"", "\"" + CANONICAL_ROOT + "\"");
  }

  /** Points at the first differing line: a 5000-line unified diff helps nobody. */
  private static String firstDifference(String expected, String actual) {
    List<String> want = expected.lines().toList();
    List<String> got = actual.lines().toList();
    for (int i = 0; i < Math.min(want.size(), got.size()); i++) {
      if (!want.get(i).equals(got.get(i))) {
        return "the model diverges from the committed snapshot at line "
            + (i + 1)
            + "\n  expected: "
            + want.get(i).strip()
            + "\n  actual  : "
            + got.get(i).strip();
      }
    }
    return "the model matches the snapshot for "
        + Math.min(want.size(), got.size())
        + " lines, then differs in length (snapshot "
        + want.size()
        + " lines, actual "
        + got.size()
        + ")";
  }

  private static void write(Path file, String content) {
    try {
      Files.createDirectories(file.getParent());
      Files.writeString(file, content, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
