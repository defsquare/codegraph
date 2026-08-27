package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.ExtractorInfo;
import dev.codegraph.spoon.model.JsonlWriter;
import dev.codegraph.spoon.model.Model;
import dev.codegraph.spoon.model.Repository;
import dev.codegraph.spoon.model.TraitName;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Repository provenance (M10a): three passthrough flags copied verbatim into
 * the header. The extractor holds NO git knowledge — whoever runs it supplies
 * the facts — but it does hold the published schema, so a value the contract
 * cannot express is refused at the flag rather than written into a model the
 * analyzer would then refuse whole.
 */
class RepositoryFactsTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final String SHA = "4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1";

  @Test
  @DisplayName("the three flags become the header's repository block")
  void flagsBecomeRepositoryFacts() {
    Main.Options options =
        Main.Options.parse(
            new String[] {
              "--repo-remote", "https://github.com/google/gson",
              "--repo-commit", SHA,
              "--repo-root", "gson/src/main/java"
            });

    assertEquals(
        new Repository("https://github.com/google/gson", SHA, "gson/src/main/java", null),
        options.repository());
  }

  @Test
  @DisplayName("no flags: no repository — a model that does not know says nothing")
  void absentByDefault() {
    assertNull(Main.Options.parse(new String[0]).repository());
    assertFalse(write(model(null)).contains("repository"));
  }

  @Test
  @DisplayName("--repo-root defaults to the repository root itself")
  void rootDefaultsToEmpty() {
    Main.Options options =
        Main.Options.parse(
            new String[] {"--repo-remote", "https://github.com/google/gson", "--repo-commit", SHA});

    assertEquals("", options.repository().root());
  }

  @Test
  @DisplayName("the facts come together: a remote without a sha links nowhere")
  void partialFactsAreRefused() {
    assertThrows(
        IllegalArgumentException.class,
        () -> Main.Options.parse(new String[] {"--repo-remote", "https://github.com/google/gson"}));
    assertThrows(
        IllegalArgumentException.class,
        () -> Main.Options.parse(new String[] {"--repo-commit", SHA}));
    assertThrows(
        IllegalArgumentException.class,
        () -> Main.Options.parse(new String[] {"--repo-root", "src/main/java"}));
  }

  @Test
  @DisplayName("a value the published schema cannot express is refused at the flag")
  void nonConformingValuesAreRefused() {
    for (String remote :
        List.of("git@github.com:google/gson.git", "https://github.com/google/gson.git", "")) {
      assertThrows(IllegalArgumentException.class, () -> new Repository(remote, SHA, "", null), remote);
    }
    for (String commit : List.of("main", "HEAD", "")) {
      assertThrows(
          IllegalArgumentException.class,
          () -> new Repository("https://github.com/google/gson", commit, "", null),
          commit);
    }
    for (String root : List.of("/src", "../src", "src/", "./src")) {
      assertThrows(
          IllegalArgumentException.class,
          () -> new Repository("https://github.com/google/gson", SHA, root, null),
          root);
    }
  }

  @Test
  @DisplayName("the header carries the facts verbatim and still validates against schemas/")
  void headerCarriesTheFactsAndConforms() {
    Repository repository =
        new Repository("https://gitlab.example.com/team/app", SHA, "app/src", "gitlab");
    String jsonl = write(model(repository));

    JsonNode header = firstRecord(jsonl);
    assertEquals("https://gitlab.example.com/team/app", header.path("repository").path("remote").asText());
    assertEquals(SHA, header.path("repository").path("commit").asText());
    assertEquals("app/src", header.path("repository").path("root").asText());
    assertEquals("gitlab", header.path("repository").path("provider").asText());

    List<String> violations = ExtractorHarness.schemaViolations(jsonl);
    assertTrue(violations.isEmpty(), () -> "schema violations: " + violations);
  }

  // --------------------------------------------------------------- fixtures

  private static Model model(Repository repository) {
    Entity module =
        Entity.builder("java:com.acme", "package")
            .named("com.acme")
            .definedIn(List.of("com/acme/A.java"), false)
            .marker(TraitName.TWithChildren)
            .build();
    Entity type =
        Entity.builder("java:com.acme/A", "class")
            .named("A")
            .type(false)
            .childOf("java:com.acme")
            .build();
    return Model.sorted(
        new ExtractorInfo("codegraph-spoon", "0.0.0-test", Boolean.TRUE),
        "/corpus",
        repository,
        List.of(module, type),
        List.of());
  }

  private static String write(Model model) {
    return new JsonlWriter().toJsonl(model);
  }

  private static JsonNode firstRecord(String jsonl) {
    try {
      return MAPPER.readTree(jsonl.split("\n")[0]);
    } catch (IOException e) {
      throw new AssertionError("unparseable header", e);
    }
  }
}
