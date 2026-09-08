package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
      if (Files.isRegularFile(directory.resolve("schemas/README.md"))) {
        return directory;
      }
      directory = directory.getParent();
    }
    throw new AssertionError(
        "no repo root (a directory containing schemas/README.md) above "
            + Path.of("").toAbsolutePath());
  }

  /** The published JSON Schema for one record type, by its {@code t} tag. */
  static String recordSchema(String tag) {
    return read(repoRoot().resolve("schemas/" + tag + ".record.schema.json"));
  }

  /**
   * Validates a whole JSONL model against the published per-record schemas —
   * every line, against the schema its {@code t} selects. This is the bar for an
   * extractor in ANY language: nothing here reaches into {@code @codegraph/core}.
   *
   * <p>What the schemas cannot check, and what {@link Jsonl#decode} checks
   * instead as it reads: section order, dense surrogates, closure, eof counts.
   */
  static List<String> schemaViolations(String jsonl) {
    Map<String, Schema> schemas = new LinkedHashMap<>();
    List<String> violations = new ArrayList<>();
    int lineNumber = 0;
    for (String line : jsonl.split("\n")) {
      lineNumber++;
      if (line.isBlank()) {
        continue;
      }
      String tag;
      try {
        tag = MAPPER.readTree(line).path("t").asText();
      } catch (IOException e) {
        violations.add("line " + lineNumber + ": not JSON: " + e.getMessage());
        continue;
      }
      if (tag.isEmpty()) {
        violations.add("line " + lineNumber + ": record has no `t` tag");
        continue;
      }
      Schema schema =
          schemas.computeIfAbsent(
              tag,
              t ->
                  SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
                      .getSchema(recordSchema(t), InputFormat.JSON));
      for (Error error : schema.validate(line, InputFormat.JSON)) {
        violations.add("line " + lineNumber + " (" + tag + "): " + error);
      }
    }
    return violations;
  }

  /** One extraction run over the fixture corpus, writing into {@code outFile}. */
  static Run runOnFixtures(Path outFile) {
    return run(fixtureCorpus(), outFile);
  }

  static Run run(Path corpus, Path outFile, String... extraArgs) {
    return runWith(List.of(), corpus, outFile, extraArgs);
  }

  /**
   * The same run with extra JVM options. The extractor forks a real JVM, which
   * is what makes a PLATFORM behaviour reachable from a test: {@code
   * -Dline.separator} reproduces on Linux the CRLF a Windows runner would
   * produce, and the model must not notice either way.
   */
  static Run runWith(List<String> jvmOptions, Path corpus, Path outFile, String... extraArgs) {
    List<String> command = new ArrayList<>();
    command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
    command.addAll(jvmOptions);
    command.add("-cp");
    command.add(System.getProperty("java.class.path"));
    command.add(Main.class.getName());
    command.add("--src");
    command.add(corpus.toString());
    command.add("--out");
    command.add(outFile.toString());
    command.addAll(List.of(extraArgs));

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
      String invocation =
          "Main --src " + corpus + " --out " + outFile + " " + String.join(" ", extraArgs);
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

    /** The file as it shipped: one parsed record per non-blank line. */
    List<JsonNode> records() {
      List<JsonNode> records = new ArrayList<>();
      for (String line : json().split("\n")) {
        if (line.isBlank()) {
          continue;
        }
        try {
          records.add(MAPPER.readTree(line));
        } catch (IOException e) {
          throw new AssertionError("unparseable line in " + modelFile + ": " + line, e);
        }
      }
      return records;
    }

    List<JsonNode> recordsOfType(String tag) {
      return records().stream().filter(record -> tag.equals(record.path("t").asText())).toList();
    }

    JsonNode header() {
      return records().get(0);
    }

    /**
     * The emitted model as the LOGICAL tree the metamodel describes: surrogates
     * resolved back to rendered ids, file references back to paths, dictionary
     * indices back to names. Tests assert on meaning; only the few that are about
     * the encoding itself read {@link #records()}.
     *
     * <p>This is a second, independent decoder — core has one in TypeScript — so
     * a writer bug that both halves share has to be introduced twice.
     */
    JsonNode model() {
      return Jsonl.decode(records(), modelFile);
    }

    List<JsonNode> entities() {
      return elements(model().path("entities"));
    }

    List<JsonNode> edges() {
      return elements(model().path("edges"));
    }
  }

  /**
   * Decodes the JSONL interchange (schemas/README.md) back into the logical
   * model. Deliberately written against the published contract alone — no
   * import from {@code dev.codegraph.spoon.model} — because that is exactly what
   * a consumer in another language has to do.
   */
  static final class Jsonl {

    private Jsonl() {}

    static JsonNode decode(List<JsonNode> records, Path source) {
      if (records.isEmpty()) {
        throw new AssertionError("empty model file: " + source);
      }
      JsonNode header = records.get(0);
      if (!"header".equals(header.path("t").asText())) {
        throw new AssertionError("first record is not a header in " + source);
      }
      JsonNode dict = header.path("dict");

      List<String> files = new ArrayList<>();
      List<JsonNode> entityRecords = new ArrayList<>();
      List<JsonNode> edgeRecords = new ArrayList<>();
      JsonNode eof = null;
      for (JsonNode record : records.subList(1, records.size())) {
        switch (record.path("t").asText()) {
          case "f" -> files.add(record.path("path").asText());
          case "e" -> entityRecords.add(record);
          case "x" -> edgeRecords.add(record);
          case "eof" -> eof = record;
          default -> throw new AssertionError("unknown record type in " + source + ": " + record);
        }
      }
      if (eof == null) {
        throw new AssertionError("no eof record — truncated file: " + source);
      }
      assertCount(eof, "files", files.size(), source);
      assertCount(eof, "entities", entityRecords.size(), source);
      assertCount(eof, "edges", edgeRecords.size(), source);

      String lang = header.path("lang").asText();
      List<String> ids = new ArrayList<>(entityRecords.size());
      for (int i = 0; i < entityRecords.size(); i++) {
        JsonNode record = entityRecords.get(i);
        int module = record.path("m").asInt();
        String symbol = record.path("s").asText();
        String modulePath = module == i ? symbol : entityRecords.get(module).path("s").asText();
        StringBuilder id = new StringBuilder(lang).append(':').append(modulePath);
        if (module != i && !symbol.isEmpty()) {
          id.append('/').append(symbol);
        }
        if (record.has("d")) {
          id.append('#').append(record.path("d").asText());
        }
        ids.add(id.toString());
      }

      ObjectMapper mapper = MAPPER;
      var entities = mapper.createArrayNode();
      for (int i = 0; i < entityRecords.size(); i++) {
        JsonNode record = entityRecords.get(i);
        var entity = mapper.createObjectNode();
        entity.put("id", ids.get(i));
        entity.put("kind", dict.path("kinds").path(record.path("k").asInt()).asText());
        var traits = mapper.createArrayNode();
        record.path("tr").forEach(ref -> traits.add(dict.path("traits").path(ref.asInt()).asText()));
        entity.set("traits", traits);
        copyText(record, entity, "name");
        copyText(record, entity, "signature");
        copyRef(record, entity, "declaredType", ids);
        if (record.has("isStub")) {
          entity.put("isStub", record.path("isStub").asBoolean());
        }
        copyRef(record, entity, "parent", ids);
        copyRef(record, entity, "attachedTo", ids);
        copyRefs(record, entity, "parameters", ids);
        copyRefs(record, entity, "localVariables", ids);
        copyRefs(record, entity, "definedIn", files);
        if (record.has("comments")) {
          entity.set("comments", record.path("comments"));
        }
        if (record.has("anchor")) {
          entity.set("anchor", anchor(record.path("anchor"), files));
        }
        entities.add(entity);
      }

      var edges = mapper.createArrayNode();
      for (JsonNode record : edgeRecords) {
        var edge = mapper.createObjectNode();
        edge.put("edge", dict.path("edges").path(record.path("k").asInt()).asText());
        edge.put("from", ids.get(record.path("f").asInt()));
        edge.put("to", ids.get(record.path("o").asInt()));
        edge.put("provenance", dict.path("provenance").path(record.path("p").asInt()).asText());
        edge.set("anchor", anchor(record.path("anchor"), files));
        copyRefs(record, edge, "candidates", ids);
        if (record.has("isRead")) {
          edge.put("isRead", record.path("isRead").asBoolean());
        }
        if (record.has("isWrite")) {
          edge.put("isWrite", record.path("isWrite").asBoolean());
        }
        if (record.has("sourceFile")) {
          edge.put("sourceFile", files.get(record.path("sourceFile").asInt()));
        }
        edges.add(edge);
      }

      var model = mapper.createObjectNode();
      model.put("schemaVersion", header.path("schemaVersion").asText());
      model.put("lang", lang);
      model.set("extractor", header.path("extractor"));
      model.put("root", header.path("root").asText());
      model.set("entities", entities);
      model.set("edges", edges);
      return model;
    }

    private static void assertCount(JsonNode eof, String what, int actual, Path source) {
      int declared = eof.path("counts").path(what).asInt(-1);
      if (declared != actual) {
        throw new AssertionError(
            source + ": eof declares " + declared + " " + what + " but the file carries " + actual);
      }
    }

    private static JsonNode anchor(JsonNode triple, List<String> files) {
      var anchor = MAPPER.createObjectNode();
      anchor.put("file", files.get(triple.path(0).asInt()));
      var span = MAPPER.createArrayNode();
      span.add(triple.path(1).asInt());
      span.add(triple.path(2).asInt());
      anchor.set("span", span);
      return anchor;
    }

    private static void copyText(
        JsonNode record, com.fasterxml.jackson.databind.node.ObjectNode target, String key) {
      if (record.has(key)) {
        target.put(key, record.path(key).asText());
      }
    }

    private static void copyRef(
        JsonNode record,
        com.fasterxml.jackson.databind.node.ObjectNode target,
        String key,
        List<String> table) {
      if (record.has(key)) {
        target.put(key, table.get(record.path(key).asInt()));
      }
    }

    private static void copyRefs(
        JsonNode record,
        com.fasterxml.jackson.databind.node.ObjectNode target,
        String key,
        List<String> table) {
      if (!record.has(key)) {
        return;
      }
      var array = MAPPER.createArrayNode();
      record.path(key).forEach(ref -> array.add(table.get(ref.asInt())));
      target.set(key, array);
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
