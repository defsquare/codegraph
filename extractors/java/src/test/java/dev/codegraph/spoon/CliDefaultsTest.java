package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A bare invocation must be useful: extract the directory you are standing in,
 * into a file named after it. The defaults are resolved against the process's
 * working directory, so the end-to-end case forks a JVM rooted elsewhere —
 * a unit assertion alone could not tell a default apart from a hard-coded path.
 */
class CliDefaultsTest {

  @TempDir Path work;

  @Test
  @DisplayName("no arguments: --src defaults to the current directory")
  void sourceDefaultsToCurrentDirectory() {
    assertEquals(List.of(Path.of(".")), Main.Options.parse(new String[0]).sources());
  }

  @Test
  @DisplayName("no arguments: --out defaults to <current-dir>-codegraph.jsonl")
  void outDefaultsToDirectoryName() {
    String directory = Path.of("").toAbsolutePath().normalize().getFileName().toString();

    assertEquals(
        Path.of(directory + "-codegraph.jsonl"), Main.Options.parse(new String[0]).out());
  }

  @Test
  @DisplayName("an explicit value still wins over each default")
  void explicitValuesWin() {
    Main.Options options =
        Main.Options.parse(new String[] {"--src", "src/main/java", "--out", "elsewhere.jsonl"});

    assertEquals(List.of(Path.of("src/main/java")), options.sources());
    assertEquals(Path.of("elsewhere.jsonl"), options.out());
  }

  @Test
  @DisplayName("run with no arguments in a corpus directory, and it extracts itself")
  void bareRunExtractsTheWorkingDirectory() throws Exception {
    Path corpus = Files.createDirectory(work.resolve("my-corpus"));
    Files.writeString(
        corpus.resolve("Greeter.java"),
        "package demo;\npublic class Greeter { public String hi() { return \"hi\"; } }\n");

    Process process =
        new ProcessBuilder(javaCommand())
            .directory(corpus.toFile())
            .redirectOutput(work.resolve("stdout").toFile())
            .redirectError(work.resolve("stderr").toFile())
            .start();
    assertTrue(process.waitFor(180, TimeUnit.SECONDS), "the extractor did not finish");

    String stderr = Files.readString(work.resolve("stderr"));
    assertEquals(0, process.exitValue(), stderr);
    Path expected = corpus.resolve("my-corpus-codegraph.jsonl");
    assertTrue(Files.exists(expected), () -> "no " + expected.getFileName() + ":\n" + stderr);
    assertTrue(Files.readString(expected).contains("\"s\":\"Greeter\""), stderr);

    // The defaults are the case the notice exists for: neither path was typed,
    // and both are relative to a working directory the caller may not be in.
    // Compared as paths, not as text: the notice does not resolve symlinks, and
    // on macOS a temp directory is one.
    List<String> notice = Files.readString(work.resolve("stdout")).lines().toList();
    assertEquals(2, notice.size(), () -> "unexpected stdout: " + notice);
    assertEquals(corpus.toRealPath(), realPath(notice.get(0), "source: "));
    assertEquals(expected.toRealPath(), realPath(notice.get(1), "model:  "));
  }

  /** The absolute path a notice line names, canonical so two spellings compare equal. */
  private static Path realPath(String line, String prefix) throws Exception {
    assertTrue(line.startsWith(prefix), () -> "expected a " + prefix.trim() + " line: " + line);
    Path path = Path.of(line.substring(prefix.length()));
    assertTrue(path.isAbsolute(), () -> "the notice must name an absolute path: " + line);
    return path.toRealPath();
  }

  /** The forked JVM starts elsewhere, so every classpath entry must be absolute. */
  private static List<String> javaCommand() {
    List<String> command = new ArrayList<>();
    command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
    command.add("-cp");
    command.add(
        Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator))
            .map(entry -> Path.of(entry).toAbsolutePath().toString())
            .collect(Collectors.joining(java.io.File.pathSeparator)));
    command.add(Main.class.getName());
    return command;
  }
}
