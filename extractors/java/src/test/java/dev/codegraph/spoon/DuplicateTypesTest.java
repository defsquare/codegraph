package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A corpus is not a compilation unit. Multi-module builds (Maven, Gradle) give
 * every module its own source roots, so the SAME fully-qualified name may be
 * declared in two of them and still compile — each module sees only its own.
 * Spoon compiles every {@code --src} root as one JDT batch, where that is
 * {@code IProblem.DuplicateTypes} and, by default, a fatal
 * {@code ModelBuildingException} that loses the other 4,971 files with it.
 *
 * <p>Extraction must survive it: analyzing a corpus cannot be conditional on the
 * corpus being compilable as a single unit. JDT keeps the first declaration and
 * discards the rest, so the loss is real — and the run has to SAY so, per the
 * interchange rule that a producer which drops something reports it.
 */
class DuplicateTypesTest {

  private static final String TYPE = "java:com.acme.infra.template/AbstractConfigurationTest";

  private static final String IN_FILESTORE =
      """
      package com.acme.infra.template;

      public abstract class AbstractConfigurationTest {
        protected String fromFilestore() {
          return "filestore";
        }
      }
      """;

  /** Same package, same name, different Maven module — legal, and not compilable together. */
  private static final String IN_JSONSTORE =
      """
      package com.acme.infra.template;

      public abstract class AbstractConfigurationTest {
        protected int fromJsonstore() {
          return 42;
        }
      }
      """;

  private static final String UNAFFECTED =
      """
      package com.acme.domain;

      public class OrderService {
        public String name() {
          return "order";
        }
      }
      """;

  @Test
  void extractsACorpusThatDeclaresOneTypeInTwoModules(@TempDir Path work) throws IOException {
    Path corpus = work.resolve("corpus");
    write(corpus, "infra-filestore/src/test/java/com/acme/infra/template/AbstractConfigurationTest.java", IN_FILESTORE);
    write(corpus, "infra-jsonstore/src/test/java/com/acme/infra/template/AbstractConfigurationTest.java", IN_JSONSTORE);
    write(corpus, "domain/src/main/java/com/acme/domain/OrderService.java", UNAFFECTED);

    ExtractorHarness.Run run =
        ExtractorHarness.run(corpus, work.resolve("model.jsonl"), "--no-progress").succeeded();

    // The rest of the corpus survives: a duplicate is not a reason to lose it.
    assertTrue(
        idsOf(run).contains("java:com.acme.domain/OrderService"),
        "the unaffected module is missing from the model:\n" + run.stderr());

    // Exactly one entity carries the duplicated id — ids stay unique per model.
    assertEquals(
        1,
        idsOf(run).stream().filter(TYPE::equals).count(),
        "the duplicated type must appear exactly once");
  }

  @Test
  void reportsTheDeclarationItHadToDrop(@TempDir Path work) throws IOException {
    Path corpus = work.resolve("corpus");
    write(corpus, "infra-filestore/src/test/java/com/acme/infra/template/AbstractConfigurationTest.java", IN_FILESTORE);
    write(corpus, "infra-jsonstore/src/test/java/com/acme/infra/template/AbstractConfigurationTest.java", IN_JSONSTORE);

    ExtractorHarness.Run run =
        ExtractorHarness.run(corpus, work.resolve("model.jsonl"), "--no-progress").succeeded();

    // Which of the two JDT reaches first is its business; that exactly one
    // survives, and that the report names the OTHER, is the extractor's.
    List<String> ids = idsOf(run);
    boolean filestoreSurvived = ids.contains(TYPE + ".fromFilestore()");
    boolean jsonstoreSurvived = ids.contains(TYPE + ".fromJsonstore()");
    assertTrue(
        filestoreSurvived ^ jsonstoreSurvived,
        "exactly one of the two declarations must survive, got filestore="
            + filestoreSurvived
            + " jsonstore="
            + jsonstoreSurvived);

    String dropped = filestoreSurvived ? "infra-jsonstore" : "infra-filestore";
    String stderr = run.stderr();
    assertTrue(
        stderr.contains("AbstractConfigurationTest"),
        "the run never names the duplicated type:\n" + stderr);
    assertTrue(
        stderr.contains(dropped),
        "the run never names " + dropped + ", whose declaration it dropped:\n" + stderr);
  }

  private static List<String> idsOf(ExtractorHarness.Run run) {
    return run.entities().stream().map(entity -> entity.path("id").asText()).toList();
  }

  private static void write(Path corpus, String relative, String source) throws IOException {
    Path file = corpus.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }
}
