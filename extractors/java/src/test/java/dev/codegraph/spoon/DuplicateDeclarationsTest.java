package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A multi-module corpus may legally declare the SAME fully-qualified name in
 * two modules — each Maven module compiles alone, so javac never sees the
 * clash. Spoon builds all roots as ONE compilation unit, and JDT's duplicate
 * error must not kill the run: a legacy corpus is exactly where this happens
 * (found on a real corpus: two infra modules each carrying a copy-pasted
 * {@code infrastructure.template.AbstractConfigurationTest}).
 *
 * <p>Distinct packages sharing a simple name are NOT duplicates — identity is
 * the qualified name — and must survive as distinct entities.
 */
class DuplicateDeclarationsTest {

  @TempDir static Path corpus;
  @TempDir static Path outDir;

  private static ExtractorHarness.Run run;

  @BeforeAll
  static void extract() throws IOException {
    // Two "modules" declaring the identical FQN com.acme.shared.Config…
    write(
        "module-a/src/com/acme/shared/Config.java",
        """
        package com.acme.shared;

        public class Config {
          public String fromA() { return "a"; }
        }
        """);
    write(
        "module-b/src/com/acme/shared/Config.java",
        """
        package com.acme.shared;

        public class Config {
          public String fromB() { return "b"; }
        }
        """);
    // …and the same simple name in two different packages: never a clash.
    write(
        "module-a/src/com/acme/alpha/Widget.java",
        """
        package com.acme.alpha;

        public class Widget {}
        """);
    write(
        "module-b/src/com/acme/beta/Widget.java",
        """
        package com.acme.beta;

        public class Widget {}
        """);

    run = ExtractorHarness.run(corpus, outDir.resolve("model.jsonl"));
  }

  private static void write(String relative, String source) throws IOException {
    Path file = corpus.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }

  @Test
  void duplicateFqnDoesNotAbortExtraction() {
    run.succeeded();
  }

  @Test
  void sameSimpleNameInDifferentPackagesYieldsDistinctEntities() {
    Set<String> ids = new HashSet<>();
    for (JsonNode entity : run.succeeded().entities()) {
      ids.add(entity.path("id").asText());
    }
    assertTrue(ids.contains("java:com.acme.alpha/Widget"), "alpha Widget missing from " + ids);
    assertTrue(ids.contains("java:com.acme.beta/Widget"), "beta Widget missing from " + ids);
  }

  @Test
  void duplicateFqnIsKeptOnceAndIdsStayUnique() {
    List<String> all = new ArrayList<>();
    for (JsonNode entity : run.succeeded().entities()) {
      all.add(entity.path("id").asText());
    }
    long configs = all.stream().filter("java:com.acme.shared/Config"::equals).count();
    assertEquals(1, configs, "one declaration survives, the other is dropped: " + all);
    assertEquals(new HashSet<>(all).size(), all.size(), "duplicate entity ids emitted: " + all);
  }
}
