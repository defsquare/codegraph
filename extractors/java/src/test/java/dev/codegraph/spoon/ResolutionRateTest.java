package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * PLAN.md §5.3 requires the extractor to "report unresolved counts in the
 * extractor's stderr summary". That makes the summary an output format, not a log
 * line, so it is parsed here exactly as a CI job or a human would read it.
 *
 * <p><b>THE THRESHOLD IS DELIBERATELY LOW AND MUST STAY LOW. DO NOT "FIX" IT
 * UPWARD.</b> PLAN.md's ≥85% target is for a REAL corpus, and this is a fixture
 * engineered around what Spoon CANNOT resolve: {@code Invoice} is declared
 * nowhere, {@code MissingLib} is imported from a package that does not exist.
 * Whatever number those produce is a property of the fixture, not of the
 * extractor, so asserting it tightly would only invite someone to delete the
 * unresolvable half of the corpus — and with it the only executable evidence for
 * PLAN.md §5.2. The floor below is a smoke test with one job: catch "Spoon
 * resolved nothing at all", which means the model was built wrong (no sources
 * found, wrong compliance level) rather than the corpus being hard.
 *
 * <p>For calibration: at the time of writing the fixtures measure ~96%, which is
 * higher than it looks — JDK types resolve against the classpath of whichever JVM
 * runs the extractor, and only the two genuinely absent types fail. That number
 * is deliberately NOT asserted; {@link #theFixtureCorpusStillContainsUnresolvableReferences}
 * asserts the direction that actually matters.
 */
class ResolutionRateTest {

  /** Smoke floor for the fixtures only. Real-corpus target (≥85%) is measured elsewhere. */
  private static final double FIXTURE_FLOOR = 0.25;

  private static final Pattern COUNT =
      Pattern.compile("^\\s*(type references|resolved|unresolved)\\s*:\\s*(\\d+)\\s*$", Pattern.MULTILINE);
  // The rate is formatted with %.1f, whose decimal separator follows the JVM's
  // locale — accept both rather than pinning the runner's locale.
  private static final Pattern RATE =
      Pattern.compile("^\\s*resolution rate\\s*:\\s*(\\d+)[.,](\\d)%\\s*$", Pattern.MULTILINE);
  private static final Pattern ENTITIES =
      Pattern.compile("^\\s*entities\\s*:\\s*(\\d+) \\(stubs: (\\d+)\\)\\s*$", Pattern.MULTILINE);
  private static final Pattern EDGES =
      Pattern.compile("^\\s*edges\\s*:\\s*(\\d+) \\(self-edges dropped: (\\d+)\\)\\s*$", Pattern.MULTILINE);

  @TempDir static Path outputDirectory;

  private static ExtractorHarness.Run run;
  private static String summary;

  @BeforeAll
  static void extract() {
    run = ExtractorHarness.runOnFixtures(outputDirectory.resolve("model.jsonl")).succeeded();
    summary = run.stderr();
  }

  @Test
  void theSummaryReportsTheFieldsPlanSection53Requires() {
    assertTrue(summary.contains("RESOLUTION SUMMARY"), () -> "no summary on stderr:\n" + summary);
    assertTrue(count("type references") > 0, () -> "no type references were counted:\n" + summary);
    assertTrue(count("resolved") >= 0, () -> "no resolved count:\n" + summary);
    assertTrue(count("unresolved") >= 0, () -> "no unresolved count:\n" + summary);
    assertTrue(RATE.matcher(summary).find(), () -> "no resolution rate:\n" + summary);
    assertTrue(ENTITIES.matcher(summary).find(), () -> "no entity/stub counts:\n" + summary);
    assertTrue(EDGES.matcher(summary).find(), () -> "no edge count:\n" + summary);
  }

  @Test
  void theCountsAreInternallyConsistent() {
    long total = count("type references");
    long resolved = count("resolved");
    long unresolved = count("unresolved");
    assertEquals(total, resolved + unresolved, () -> "resolved + unresolved ≠ total:\n" + summary);
    assertTrue(resolved <= total, () -> "more resolved than counted:\n" + summary);

    assertEquals(reportedRate(), (double) resolved / total, 0.001, () -> "the printed rate is not resolved/total:\n" + summary);
  }

  /** The summary must describe the model that was actually written, not an estimate. */
  @Test
  void theSummaryAgreesWithTheEmittedModel() {
    Matcher entities = ENTITIES.matcher(summary);
    assertTrue(entities.find());
    assertEquals(run.entities().size(), Integer.parseInt(entities.group(1)), "entity count");
    assertEquals(
        run.entities().stream().filter(entity -> entity.path("isStub").asBoolean()).count(),
        Long.parseLong(entities.group(2)),
        "stub count");

    Matcher edges = EDGES.matcher(summary);
    assertTrue(edges.find());
    assertEquals(run.edges().size(), Integer.parseInt(edges.group(1)), "edge count");
  }

  @Test
  void theFixtureCorpusResolvesAboveTheSmokeFloor() {
    double rate = (double) count("resolved") / count("type references");
    assertTrue(
        rate >= FIXTURE_FLOOR,
        () ->
            "resolution collapsed to %.1f%% (floor %.0f%%) — that is not a fixture property, it means the "
                    .formatted(rate * 100, FIXTURE_FLOOR * 100)
                + "Spoon model was built wrong (missing sources, wrong compliance level).\n"
                + summary);
  }

  /** The corpus is half-unresolvable ON PURPOSE; a perfect rate means it lost its teeth. */
  @Test
  void theFixtureCorpusStillContainsUnresolvableReferences() {
    assertTrue(
        count("unresolved") > 0,
        () ->
            "every type reference resolved. The fixtures must keep references Spoon cannot resolve "
                + "(Invoice, MissingLib) — they are the only evidence for the stub discipline.\n"
                + summary);
  }

  private static long count(String field) {
    Matcher matcher = COUNT.matcher(summary);
    while (matcher.find()) {
      if (matcher.group(1).equals(field)) {
        return Long.parseLong(matcher.group(2));
      }
    }
    throw new AssertionError("the summary has no '" + field + "' line:\n" + summary);
  }

  private static double reportedRate() {
    Matcher matcher = RATE.matcher(summary);
    assertTrue(matcher.find(), () -> "no resolution rate:\n" + summary);
    return Double.parseDouble(matcher.group(1) + "." + matcher.group(2)) / 100.0;
  }
}
