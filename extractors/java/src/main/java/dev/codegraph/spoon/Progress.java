package dev.codegraph.spoon;

import java.io.Console;
import java.io.Flushable;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.function.LongSupplier;

/**
 * A single-line progress bar on stderr, one phase of the extraction at a time.
 *
 * <p><b>stderr is an output format here, not a log</b> — the RESOLUTION SUMMARY
 * is machine-read (PLAN.md §5.3), and so is every warning {@code Main} prints.
 * The bar therefore lives under three rules:
 *
 * <ul>
 *   <li><b>{@code AUTO} draws only on a terminal.</b> Piped or redirected, the
 *       run is byte-identical to one with no progress at all — a redraw is a
 *       carriage return and an erase sequence, which a log file must never see.
 *   <li><b>The transient line is erased before anything else is written.</b>
 *       Everything a run says goes through {@link #log}, so a warning can never
 *       land in the middle of a half-drawn bar.
 *   <li><b>A total is claimed only when it is known.</b> A phase whose size the
 *       pass cannot state up front shows a spinner and a count, not a bar
 *       creeping toward a number nobody measured.
 * </ul>
 *
 * <p>Redraws are throttled (80 ms): a per-file callback on a large corpus fires
 * tens of thousands of times, and the syscall, not the extraction, would become
 * the bottleneck. Phase starts and phase ends are never throttled, so the
 * persisted per-phase timing line is exact.
 *
 * <p>Not thread-safe: the extraction is sequential, and Spoon's own progress
 * callbacks arrive on the thread that called {@code buildModel}.
 */
public final class Progress implements AutoCloseable {

  /** How the CLI's {@code --progress} option resolves. */
  public enum Mode {
    /** Bar on a terminal, complete silence otherwise. The default. */
    AUTO,
    /** One line per completed phase, no control characters — the CI form. */
    PLAIN,
    /** Nothing at all. */
    NONE;

    public static Mode parse(String value) {
      switch (value.toLowerCase(Locale.ROOT)) {
        case "auto":
          return AUTO;
        case "plain":
          return PLAIN;
        case "none":
        case "off":
          return NONE;
        default:
          throw new IllegalArgumentException(
              "--progress takes auto, plain or none (got: " + value + ")");
      }
    }
  }

  private static final long REDRAW_INTERVAL_MS = 80;
  private static final int LABEL_WIDTH = 12;
  private static final int BAR_WIDTH = 24;
  private static final int MIN_WIDTH = 40;
  private static final int MAX_WIDTH = 160;
  private static final int DEFAULT_WIDTH = 80;

  /** Carriage return, then erase-to-end-of-line: the whole ANSI vocabulary used here. */
  private static final String ERASE_LINE = "\r\u001b[2K";

  private final Appendable sink;
  private final boolean animated;
  private final int width;
  private final LongSupplier nanoClock;
  private final Glyphs glyphs;

  private Phase active;
  private boolean drawn;
  private int frame;

  private Progress(
      Appendable sink, boolean animated, int width, LongSupplier nanoClock, Glyphs glyphs) {
    this.sink = sink;
    this.animated = animated;
    this.width = clamp(width, MIN_WIDTH, MAX_WIDTH);
    this.nanoClock = nanoClock;
    this.glyphs = glyphs;
  }

  /** The reporter a {@link Mode} asks for; {@code AUTO} off a terminal is {@link #none()}. */
  public static Progress forMode(Mode mode) {
    switch (mode) {
      case PLAIN:
        return new Progress(System.err, false, DEFAULT_WIDTH, System::nanoTime, Glyphs.ascii());
      case AUTO:
        return stderrIsTerminal()
            ? new Progress(System.err, true, terminalWidth(), System::nanoTime, Glyphs.best())
            : none();
      case NONE:
      default:
        return none();
    }
  }

  /** A reporter that draws nothing — the shape every pass gets when progress is off. */
  public static Progress none() {
    return new Progress(null, false, DEFAULT_WIDTH, () -> 0L, Glyphs.ascii());
  }

  /** For tests: render into any sink with a fixed width and a controllable clock. */
  static Progress to(Appendable sink, boolean animated, int width, LongSupplier nanoClock) {
    return new Progress(sink, animated, width, nanoClock, Glyphs.ascii());
  }

  /** True when this reporter would draw anything — lets a pass skip counting work for nobody. */
  public boolean isEnabled() {
    return sink != null;
  }

  /** A phase whose size is not known up front: spinner plus a running count. */
  public Phase phase(String label, String unit) {
    return open(label, unit, -1);
  }

  /** A phase of known size: a determinate bar. A {@code total} of 0 still completes cleanly. */
  public Phase phase(String label, long total, String unit) {
    return open(label, unit, Math.max(total, 0));
  }

  /**
   * Writes a line without corrupting the bar. Every message a run emits while a
   * phase may be open must go through here.
   */
  public void log(String message) {
    if (sink == null) {
      System.err.println(message);
      return;
    }
    erase();
    append(message);
    append(System.lineSeparator());
    render(true);
  }

  @Override
  public void close() {
    if (active != null) {
      active.close();
    }
  }

  private Phase open(String label, String unit, long total) {
    if (active != null) {
      // Defensive: Spoon's sub-processes are sequential today, but a nested
      // start must never leave an orphan phase owning the line.
      active.close();
    }
    active = new Phase(label, unit, total);
    render(true);
    return active;
  }

  /** One phase of the pipeline. {@link Phase#close} is what prints its persisted timing line. */
  public final class Phase implements AutoCloseable {

    private final String label;
    private final String unit;
    private final long startedAt;
    private long total;
    private long done;
    private String detail;
    private long lastRenderMs;
    private boolean closed;

    private Phase(String label, String unit, long total) {
      this.label = label;
      this.unit = unit;
      this.total = total;
      this.startedAt = nanos();
      this.lastRenderMs = Long.MIN_VALUE;
    }

    /** Declares the size once the pass knows it — a bar replaces the spinner from here on. */
    public void total(long total) {
      this.total = Math.max(total, 0);
      render(false);
    }

    /** One unit of work done. */
    public void step() {
      at(done + 1);
    }

    /** Absolute progress, for a producer that counts for itself (Spoon does). */
    public void at(long done) {
      this.done = Math.max(done, 0);
      render(false);
    }

    /** What is being worked on right now — shown after the bar, truncated to fit. */
    public void detail(String detail) {
      this.detail = detail;
      render(false);
    }

    @Override
    public void close() {
      if (closed) {
        return;
      }
      closed = true;
      if (active == this) {
        active = null;
      }
      finish(this);
    }

    private long elapsedNanos() {
      return nanos() - startedAt;
    }

    private boolean determinate() {
      return total > 0;
    }
  }

  // ------------------------------------------------------------------ drawing

  private void render(boolean force) {
    if (sink == null || !animated || active == null) {
      return;
    }
    long nowMs = nanos() / 1_000_000L;
    if (!force && nowMs - active.lastRenderMs < REDRAW_INTERVAL_MS) {
      return;
    }
    active.lastRenderMs = nowMs;
    frame++;
    erase();
    append(line(active));
    drawn = true;
    flush();
  }

  private void finish(Phase phase) {
    if (sink == null) {
      return;
    }
    erase();
    append(completed(phase));
    append(System.lineSeparator());
    flush();
  }

  /** The transient line: {@code label [####....]  62%  1,234/2,000 files  9.8s  detail}. */
  private String line(Phase phase) {
    StringBuilder out = new StringBuilder();
    out.append(pad(phase.label));
    if (phase.determinate()) {
      double ratio = Math.min(1.0, (double) phase.done / phase.total);
      int filled = (int) Math.round(ratio * BAR_WIDTH);
      out.append(' ').append(glyphs.barOpen());
      out.append(repeat(glyphs.full(), filled));
      out.append(repeat(glyphs.empty(), BAR_WIDTH - filled));
      out.append(glyphs.barClose());
      out.append(String.format(Locale.ROOT, " %3d%%", (int) (ratio * 100)));
      out.append("  ").append(count(phase.done)).append('/').append(count(phase.total));
    } else {
      out.append(' ').append(glyphs.spinner()[frame % glyphs.spinner().length]);
      if (phase.done > 0) {
        out.append("  ").append(count(phase.done));
      }
    }
    if (phase.unit != null) {
      out.append(' ').append(phase.unit);
    }
    out.append("  ").append(duration(phase.elapsedNanos()));
    if (phase.detail != null && !phase.detail.isBlank()) {
      out.append("  ").append(phase.detail);
    }
    return truncate(out.toString(), width - 1);
  }

  /** The line that survives the phase: what it did, and how long it took. */
  private String completed(Phase phase) {
    StringBuilder out = new StringBuilder();
    out.append(glyphs.done()).append(' ').append(pad(phase.label));
    long amount = phase.determinate() ? Math.max(phase.done, phase.total) : phase.done;
    out.append(' ').append(count(amount));
    if (phase.unit != null) {
      out.append(' ').append(phase.unit);
    }
    out.append("  ").append(duration(phase.elapsedNanos()));
    return truncate(out.toString(), width - 1);
  }

  /**
   * In plain mode there is no transient line to take back: nothing was drawn, so
   * each write simply starts on its own line.
   */
  private void erase() {
    if (!drawn) {
      return;
    }
    append(animated ? ERASE_LINE : System.lineSeparator());
    drawn = false;
  }

  private static String pad(String label) {
    return label.length() >= LABEL_WIDTH ? label : label + " ".repeat(LABEL_WIDTH - label.length());
  }

  private static String repeat(String glyph, int times) {
    return times <= 0 ? "" : glyph.repeat(times);
  }

  private static String count(long value) {
    return String.format(Locale.ROOT, "%,d", value);
  }

  static String duration(long nanos) {
    double seconds = nanos / 1e9;
    if (seconds < 60) {
      return String.format(Locale.ROOT, "%.1fs", seconds);
    }
    long whole = (long) seconds;
    return String.format(Locale.ROOT, "%dm%02ds", whole / 60, whole % 60);
  }

  private static String truncate(String line, int max) {
    return line.length() <= max ? line : line.substring(0, Math.max(max, 0));
  }

  private static int clamp(int value, int min, int max) {
    return Math.max(min, Math.min(max, value));
  }

  private long nanos() {
    return nanoClock.getAsLong();
  }

  private void append(String text) {
    if (sink == null) {
      return;
    }
    try {
      sink.append(text);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to write progress to stderr", e);
    }
  }

  private void flush() {
    if (sink instanceof Flushable flushable) {
      try {
        flushable.flush();
      } catch (IOException e) {
        throw new UncheckedIOException("failed to flush progress to stderr", e);
      }
    }
  }

  // --------------------------------------------------------------- capability

  /**
   * Whether a human is watching. {@code Console.isTerminal()} is the honest
   * answer but arrives in JDK 22, and this module targets 17 — so it is called
   * reflectively when present. Before 22 a non-null {@code Console} already
   * implied a terminal, which is exactly the fallback.
   */
  private static boolean stderrIsTerminal() {
    Console console = System.console();
    if (console == null) {
      return false;
    }
    try {
      return (Boolean) Console.class.getMethod("isTerminal").invoke(console);
    } catch (ReflectiveOperationException | RuntimeException e) {
      return true;
    }
  }

  private static int terminalWidth() {
    String columns = System.getenv("COLUMNS");
    if (columns != null) {
      try {
        return Integer.parseInt(columns.trim());
      } catch (NumberFormatException ignored) {
        // An unparseable COLUMNS is not worth failing an extraction over.
      }
    }
    return DEFAULT_WIDTH;
  }

  /** Box drawing needs a UTF-8 terminal; anywhere else the bar degrades to ASCII. */
  private record Glyphs(
      String full, String empty, String barOpen, String barClose, String done, String[] spinner) {

    static Glyphs ascii() {
      return new Glyphs("#", ".", "[", "]", "-", new String[] {"|", "/", "-", "\\"});
    }

    static Glyphs unicode() {
      return new Glyphs(
          "█",
          "░",
          "▏",
          "▕",
          "✓",
          new String[] {
            "⠋", "⠙", "⠹", "⠸", "⠼",
            "⠴", "⠦", "⠧", "⠇", "⠏"
          });
    }

    static Glyphs best() {
      return StandardCharsets.UTF_8.equals(Charset.defaultCharset()) ? unicode() : ascii();
    }
  }
}
