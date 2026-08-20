package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The progress bar is the one part of the extractor that writes to stderr for a
 * human. stderr is also an output format (the RESOLUTION SUMMARY), so what this
 * class guards is not cosmetics: that a non-terminal run stays clean, that a
 * message can never land inside a half-drawn line, and that the bar never
 * claims a total nobody measured.
 */
class ProgressTest {

  /** A clock the test drives; nothing here may depend on real elapsed time. */
  private final AtomicLong nanos = new AtomicLong();

  private void advance(long millis) {
    nanos.addAndGet(millis * 1_000_000L);
  }

  @Test
  @DisplayName("a determinate phase draws a bar with its percentage and counts")
  void determinateBar() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("entities", 200, "declarations");
    advance(100);
    phase.at(50);

    String last = lastLine(sink);
    assertTrue(last.contains("entities"), last);
    assertTrue(last.contains(" 25%"), last);
    assertTrue(last.contains("50/200 declarations"), last);
    assertTrue(last.contains("######"), () -> "no filled bar segment: " + last);
    assertTrue(last.contains("......"), () -> "no empty bar segment: " + last);
  }

  @Test
  @DisplayName("a phase of unknown size shows a spinner and a count, never a percentage")
  void indeterminatePhaseClaimsNoTotal() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("write", "records");
    advance(100);
    phase.step();

    String last = lastLine(sink);
    assertFalse(last.contains("%"), () -> "a percentage was invented: " + last);
    assertTrue(last.contains("1 records"), last);
  }

  @Test
  @DisplayName("a late total turns the spinner into a bar")
  void totalMayArriveLate() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("write", "records");
    advance(100);
    phase.total(4);
    advance(100);
    phase.at(2);

    assertTrue(lastLine(sink).contains(" 50%"), lastLine(sink));
  }

  @Test
  @DisplayName("progress past the total still reads as 100%, never more")
  void overshootIsClamped() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("edges", 7, "relation kinds");
    advance(100);
    phase.at(9);

    assertTrue(lastLine(sink).contains("100%"), lastLine(sink));
  }

  @Test
  @DisplayName("redraws are throttled, so a per-file callback cannot flood stderr")
  void redrawsAreThrottled() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("model", 10_000, "files");
    int drawnAtStart = countRedraws(sink);
    for (int i = 0; i < 10_000; i++) {
      advance(1);
      phase.at(i);
    }

    int redraws = countRedraws(sink) - drawnAtStart;
    assertTrue(redraws > 0, "the bar never moved");
    assertTrue(redraws <= 10_000 / 80 + 2, "one redraw per step: " + redraws);
  }

  @Test
  @DisplayName("a message erases the bar first, so no line is ever half-drawn")
  void logErasesTheBarBeforeWriting() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("edges", 7, "relation kinds");
    advance(100);
    phase.at(3);
    progress.log("warning: dropped an edge");

    String rendered = sink.toString();
    int warning = rendered.indexOf("warning: dropped an edge");
    assertTrue(warning > 0, rendered);
    // Whatever precedes the message is an erase, not bar text.
    assertTrue(
        rendered.substring(0, warning).endsWith("\u001b[2K"),
        () -> "the message was written over a live bar: " + visible(rendered));
  }

  @Test
  @DisplayName("closing a phase leaves one line stating what it did and how long it took")
  void closedPhaseLeavesASummaryLine() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    try (Progress.Phase phase = progress.phase("whitelist", 1_234, "types")) {
      advance(2_500);
      phase.at(1_234);
    }

    String summary = lastLine(sink);
    assertTrue(summary.contains("whitelist"), summary);
    assertTrue(summary.contains("1,234 types"), summary);
    assertTrue(summary.contains("2.5s"), summary);
  }

  @Test
  @DisplayName("plain mode writes lines only — no carriage returns, no escapes")
  void plainModeHasNoControlCharacters() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, false, 80, nanos::get);

    try (Progress.Phase phase = progress.phase("compile", 3, "files")) {
      advance(1_000);
      phase.at(3);
    }
    progress.log("RESOLUTION SUMMARY");

    String rendered = sink.toString();
    assertFalse(rendered.contains("\r"), () -> visible(rendered));
    assertFalse(rendered.contains("\u001b"), () -> visible(rendered));
    assertEquals(2, rendered.lines().count(), rendered);
  }

  @Test
  @DisplayName("a disabled reporter draws nothing at all")
  void noneDrawsNothing() {
    Progress progress = Progress.none();
    assertFalse(progress.isEnabled());
    try (Progress.Phase phase = progress.phase("model", 10, "files")) {
      phase.step();
      phase.detail("Anything.java");
    }
    // Nothing to assert on a sink that does not exist: the contract is that no
    // call throws and no stream is touched. `log` still reaches stderr, because
    // a warning must survive progress being off.
  }

  @Test
  @DisplayName("opening a phase closes the one that owns the line")
  void onlyOnePhaseOwnsTheLine() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    progress.phase("model", 5, "files");
    advance(100);
    progress.phase("imports", 5, "files");

    assertTrue(sink.toString().contains("- model"), () -> visible(sink.toString()));
  }

  @Test
  @DisplayName("closing a phase twice reports it once")
  void closeIsIdempotent() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 80, nanos::get);

    Progress.Phase phase = progress.phase("stubs", 2, "references");
    phase.close();
    phase.close();

    // Only the completion line counts; the transient bar frame mentions the
    // phase too, and `lines()` treats the carriage return as a terminator.
    assertEquals(1, sink.toString().lines().filter(line -> line.contains("- stubs")).count());
  }

  @Test
  @DisplayName("a line never exceeds the terminal width")
  void lineFitsTheTerminal() {
    StringBuilder sink = new StringBuilder();
    Progress progress = Progress.to(sink, true, 40, nanos::get);

    Progress.Phase phase = progress.phase("model", 1_000_000, "files");
    advance(100);
    phase.at(999_999);
    phase.detail("SomeVeryLongCompilationUnitName.java");

    for (String line : sink.toString().split("\u001b\\[2K")) {
      assertTrue(line.replace("\r", "").length() <= 39, () -> "too wide: " + line);
    }
  }

  @Test
  @DisplayName("--progress takes auto, plain or none")
  void modeParsing() {
    assertEquals(Progress.Mode.AUTO, Progress.Mode.parse("auto"));
    assertEquals(Progress.Mode.PLAIN, Progress.Mode.parse("PLAIN"));
    assertEquals(Progress.Mode.NONE, Progress.Mode.parse("none"));
    assertEquals(Progress.Mode.NONE, Progress.Mode.parse("off"));
    assertThrows(IllegalArgumentException.class, () -> Progress.Mode.parse("yes"));
  }

  @Test
  @DisplayName("a duration reads in seconds, then in minutes")
  void durationsAreReadable() {
    assertEquals("0.5s", Progress.duration(500_000_000L));
    assertEquals("12.3s", Progress.duration(12_345_000_000L));
    assertEquals("2m05s", Progress.duration(125_000_000_000L));
  }

  /** What the terminal would show after the last erase. */
  private static String lastLine(CharSequence rendered) {
    String[] frames = rendered.toString().split("\u001b\\[2K");
    return frames[frames.length - 1].replace("\r", "").trim();
  }

  private static int countRedraws(CharSequence rendered) {
    return rendered.toString().split("\u001b\\[2K", -1).length - 1;
  }

  private static String visible(String rendered) {
    return rendered.replace("\u001b", "<ESC>").replace("\r", "<CR>");
  }
}
