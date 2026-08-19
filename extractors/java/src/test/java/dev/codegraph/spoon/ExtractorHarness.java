package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Runs the real extractor the way a user does — {@code Main} with {@code --src}
 * and {@code --out} — and hands back its exit code, its stderr and the model it
 * wrote. Everything downstream of this class asserts against actual output, not
 * against a reimplementation of the pipeline.
 *
 * <p><b>Why a forked JVM rather than calling {@code Main.main} in-process:</b>
 * {@code Main} answers failures with {@code System.exit}, which would kill the
 * surefire JVM and turn "one extraction pass is unimplemented" into "the whole
 * test run vanished". A subprocess also makes the stderr RESOLUTION SUMMARY
 * readable as the byte stream PLAN.md §5.3 promises, which is what
 * {@link ResolutionRateTest} parses. The fork reuses the test JVM's own
 * classpath, so no {@code package} phase (and no shaded jar) is required.
 */
final class ExtractorHarness {

  /** Long enough for a cold JVM plus a Spoon build over the fixtures; short enough to fail. */
  private static final long TIMEOUT_SECONDS = 180;

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private ExtractorHarness() {}

  /** The extraction root of the reference corpus (PLAN.md §5.3). */
  static Path fixtureCorpus() {
    Path corpus = repoRoot().resolve("fixtures/java/src");
    if (!Files.isDirectory(corpus)) {
      throw new AssertionError("the fixture corpus is missing: " + corpus);
    }
    return corpus;
  }

  /**
   * Walks up from the working directory to the repo root. Surefire's working
   * directory is {@code extractors/java}, but nothing here should depend on how
   * deep the runner happens to start.
   */
  static Path repoRoot() {
    Path directory = Path.of("").toAbsolutePath();
    while (directory != null) {
      if (Files.isRegularFile(directory.resolve("schemas/model.schema.json"))) {
        return directory;
      }
      directory = directory.getParent();
    }
    throw new AssertionError(
        "no repo root (a directory containing schemas/model.schema.json) above "
            + Path.of("").toAbsolutePath());
  }

  static String publishedSchema() {
    return read(repoRoot().resolve("schemas/model.schema.json"));
  }

  /** One extraction run over the fixture corpus, writing into {@code outFile}. */
  static Run runOnFixtures(Path outFile) {
    return run(fixtureCorpus(), outFile);
  }

  static Run run(Path corpus, Path outFile) {
    List<String> command = new ArrayList<>();
    command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
    command.add("-cp");
    command.add(System.getProperty("java.class.path"));
    command.add(Main.class.getName());
    command.add("--src");
    command.add(corpus.toString());
    command.add("--out");
    command.add(outFile.toString());
    command.add("--pretty");

    // Both streams go to files rather than pipes: draining two pipes from one
    // thread deadlocks as soon as either fills, and stderr here is machine-read.
    Path stdoutFile = outFile.resolveSibling(outFile.getFileName() + ".stdout");
    Path stderrFile = outFile.resolveSibling(outFile.getFileName() + ".stderr");

    try {
      Process process =
          new ProcessBuilder(command)
              .directory(repoRoot().toFile())
              .redirectOutput(stdoutFile.toFile())
              .redirectError(stderrFile.toFile())
              .start();
      if (!process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        throw new AssertionError("the extractor did not finish within " + TIMEOUT_SECONDS + "s");
      }
      // The classpath is omitted from the reported invocation on purpose: it is
      // thirty absolute jar paths and would bury the diagnostics under itself.
      String invocation = "Main --src " + corpus + " --out " + outFile + " --pretty";
      return new Run(process.exitValue(), read(stdoutFile), read(stderrFile), outFile, invocation);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new AssertionError("interrupted while running the extractor", e);
    }
  }

  /**
   * @param exitCode 0 on success; 3 while an extraction pass is still unimplemented
   * @param stderr carries the RESOLUTION SUMMARY, and the reason on failure
   */
  record Run(int exitCode, String stdout, String stderr, Path modelFile, String command) {

    /**
     * Fails with the extractor's own diagnostics. While the seams are landing the
     * message is {@code unimplemented extraction pass: …}, which is the honest
     * failure the harness must surface rather than skip over.
     */
    Run succeeded() {
      if (exitCode != 0) {
        fail(
            "the extractor exited "
                + exitCode
                + "\n  command: "
                + command
                + "\n  stderr:\n"
                + indent(stderr)
                + (stdout.isBlank() ? "" : "\n  stdout:\n" + indent(stdout)));
      }
      if (!Files.isRegularFile(modelFile)) {
        fail("the extractor exited 0 but wrote no model at " + modelFile);
      }
      return this;
    }

    String json() {
      return read(modelFile);
    }

    byte[] bytes() {
      try {
        return Files.readAllBytes(modelFile);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    /** The emitted model as a tree — tests read the JSON that shipped, not POJOs. */
    JsonNode model() {
      try {
        return MAPPER.readTree(json());
      } catch (IOException e) {
        throw new AssertionError("the extractor wrote unparseable JSON to " + modelFile, e);
      }
    }

    List<JsonNode> entities() {
      return elements(model().path("entities"));
    }

    List<JsonNode> edges() {
      return elements(model().path("edges"));
    }
  }

  static List<JsonNode> elements(JsonNode array) {
    List<JsonNode> items = new ArrayList<>();
    array.forEach(items::add);
    return items;
  }

  /** Trait lists are compared as sets: the emitted order is canonical, not asserted here. */
  static List<String> traitsOf(JsonNode entity) {
    List<String> traits = new ArrayList<>();
    entity.path("traits").forEach(trait -> traits.add(trait.asText()));
    return traits;
  }

  static String read(Path file) {
    try {
      return Files.readString(file, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static String indent(String text) {
    return text.lines().map(line -> "    " + line).reduce((a, b) -> a + "\n" + b).orElse("    (empty)");
  }
}
