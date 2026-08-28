package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A finished run says, on stdout, WHAT it read and WHERE it wrote — the two
 * facts a caller needs and cannot otherwise recover, since both {@code --src}
 * and {@code --out} default and both may be relative to a working directory the
 * caller has since left.
 *
 * <p>Paths are absolute and normalized: the notice is meant to be copied into
 * the next command, not re-resolved by hand. Everything diagnostic — progress,
 * warnings, the RESOLUTION SUMMARY — stays on stderr, so stdout carries this
 * notice and nothing else.
 */
class CompletionNoticeTest {

  @TempDir static Path corpus;
  @TempDir static Path outDir;

  private static ExtractorHarness.Run run;

  @BeforeAll
  static void extract() throws IOException {
    write(corpus.resolve("alpha/Alpha.java"), "package alpha;\npublic class Alpha {}\n");
    write(corpus.resolve("beta/Beta.java"), "package beta;\npublic class Beta {}\n");
    run = ExtractorHarness.run(corpus, outDir.resolve("model.jsonl")).succeeded();
  }

  private static void write(Path file, String source) throws IOException {
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }

  @Test
  void stdoutNamesTheSourceRootAndTheModelFile() {
    assertEquals(
        List.of(
            "source: " + corpus.toAbsolutePath().normalize(),
            "model:  " + outDir.resolve("model.jsonl").toAbsolutePath().normalize()),
        run.stdout().lines().toList());
  }

  @Test
  void everyRootIsNamed() {
    ExtractorHarness.Run multi =
        ExtractorHarness.run(
                corpus.resolve("alpha"),
                outDir.resolve("multi.jsonl"),
                "--src",
                corpus.resolve("beta").toString())
            .succeeded();

    List<String> sources = multi.stdout().lines().filter(l -> l.startsWith("source: ")).toList();
    assertEquals(
        List.of(
            "source: " + corpus.resolve("alpha").toAbsolutePath().normalize(),
            "source: " + corpus.resolve("beta").toAbsolutePath().normalize()),
        sources);
  }

  @Test
  void theNoticeSurvivesProgressBeingOff() {
    ExtractorHarness.Run quiet =
        ExtractorHarness.run(corpus, outDir.resolve("quiet.jsonl"), "--no-progress").succeeded();

    assertTrue(
        quiet.stdout().contains("model:  " + outDir.resolve("quiet.jsonl").toAbsolutePath()),
        () -> "the notice is not progress output: " + quiet.stdout());
  }
}
