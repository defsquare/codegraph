package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What a real run does with progress. The harness forks a JVM whose streams are
 * files, i.e. exactly the redirected case: the guarantee under test is that the
 * default run is indistinguishable from one with no progress code at all, and
 * that asking for {@code plain} adds lines without touching the summary that
 * downstream tooling parses.
 */
class ProgressCliTest {

  @TempDir Path work;

  @Test
  @DisplayName("redirected, the default run writes no control characters")
  void autoIsSilentOffATerminal() {
    ExtractorHarness.Run run =
        ExtractorHarness.run(ExtractorHarness.fixtureCorpus(), work.resolve("model.jsonl"))
            .succeeded();

    assertFalse(run.stderr().contains("\r"), () -> visible(run.stderr()));
    assertFalse(run.stderr().contains("\u001b"), () -> visible(run.stderr()));
    assertTrue(run.stderr().contains("RESOLUTION SUMMARY"), run.stderr());
  }

  @Test
  @DisplayName("--progress plain reports every phase, and still ends with the summary")
  void plainReportsPhases() {
    ExtractorHarness.Run run =
        ExtractorHarness.run(
                ExtractorHarness.fixtureCorpus(),
                work.resolve("model.jsonl"),
                "--progress",
                "plain")
            .succeeded();

    String stderr = run.stderr();
    assertFalse(stderr.contains("\u001b"), () -> visible(stderr));
    for (String phase : new String[] {"whitelist", "entities", "edges", "stubs", "write"}) {
      assertTrue(stderr.contains(phase), () -> "no line for phase " + phase + ":\n" + stderr);
    }
    assertTrue(stderr.contains("RESOLUTION SUMMARY"), stderr);
  }

  @Test
  @DisplayName("--progress none and --no-progress leave stderr as it was")
  void progressCanBeTurnedOff() {
    String withNone =
        ExtractorHarness.run(
                ExtractorHarness.fixtureCorpus(),
                work.resolve("none.jsonl"),
                "--progress",
                "none")
            .succeeded()
            .stderr();
    String withFlag =
        ExtractorHarness.run(
                ExtractorHarness.fixtureCorpus(), work.resolve("flag.jsonl"), "--no-progress")
            .succeeded()
            .stderr();

    assertEquals(withNone, withFlag);
    assertFalse(withNone.contains("whitelist"), withNone);
    assertTrue(withNone.contains("RESOLUTION SUMMARY"), withNone);
  }

  @Test
  @DisplayName("progress changes nothing about the model that is written")
  void progressDoesNotAffectOutput() {
    Path quiet = work.resolve("quiet.jsonl");
    Path loud = work.resolve("loud.jsonl");
    ExtractorHarness.run(ExtractorHarness.fixtureCorpus(), quiet, "--no-progress").succeeded();
    ExtractorHarness.run(ExtractorHarness.fixtureCorpus(), loud, "--progress", "plain").succeeded();

    assertEquals(ExtractorHarness.read(quiet), ExtractorHarness.read(loud));
  }

  @Test
  @DisplayName("an unknown progress mode fails as a usage error")
  void unknownModeIsAUsageError() {
    ExtractorHarness.Run run =
        ExtractorHarness.run(
            ExtractorHarness.fixtureCorpus(), work.resolve("model.jsonl"), "--progress", "yes");

    assertEquals(2, run.exitCode(), run.stderr());
    assertTrue(run.stderr().contains("--progress takes auto, plain or none"), run.stderr());
  }

  private static String visible(String rendered) {
    return rendered.replace("\u001b", "<ESC>").replace("\r", "<CR>");
  }
}
