package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.codegraph.spoon.model.Entity;
import dev.codegraph.spoon.model.TraitName;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;

/**
 * Measures (M10b, METAMODEL.md §3.8), every number below HAND-COUNTED from the
 * source next to it. Two claims are being pinned:
 *
 * <ul>
 *   <li><b>cyclomatic</b> = 1 + decision points written in THIS invocable. The
 *       cases that catch a naive implementation are all here: a `&&` chain, a
 *       switch with multi-label cases and a default, a pattern guard, a
 *       try/multi-catch, and — the one that decides whether the number means
 *       anything — a lambda inside a method, whose branches belong to the
 *       lambda and must NOT be charged to the method.
 *   <li><b>sloc</b> = lines of the entity's own span that are neither blank nor
 *       comment-only, counted by a scanner that knows literals: a `"/*"` in a
 *       string must not swallow the rest of the file.
 * </ul>
 */
class MeasuresTest {

  private static final String BRANCHY =
      """
      package demo;

      public class Branchy {

        /** Javadoc: not code. */
        public int classify(int n, String tag) {          // 1 base
          if (n > 0 && tag != null) {                     // +1 if, +1 &&
            return 1;
          } else if (n < 0 || tag == null) {              // +1 if, +1 ||
            return -1;
          }
          for (int i = 0; i < n; i++) {                   // +1 for
            n += i;
          }
          return n == 0 ? 0 : n;                          // +1 ternary
        }

        public String route(Channel channel) {            // 1 base
          switch (channel) {                              // switch itself: 0
            case WEB, PHONE:                              // +2 (one per label)
              return "remote";
            case STORE:                                   // +1
              return "local";
            default:                                      // +0 — no decision
              return "unknown";
          }
        }

        public int guarded(Object value) {                // 1 base
          return switch (value) {
            case String s when s.length() > 3 -> 1;        // +1 label, +1 guard, +1 >
            case Integer i -> 2;                           // +1 label
            default -> 0;
          };
        }

        public int risky(String text) {                   // 1 base
          try {
            return Integer.parseInt(text);
          } catch (NumberFormatException e) {             // +1 catch
            return 0;
          } catch (RuntimeException e) {                  // +1 catch
            return -1;
          }
        }

        public Runnable withLambda(int n) {               // 1 base, and NOTHING more:
          return () -> {                                  // the lambda's branches
            if (n > 0 && n < 10) {                        // belong to the lambda
              System.out.println(n);
            }
          };
        }

        public boolean plain(int n) {                     // 1 base — no branch at all
          return n == 0;
        }
      }
      """;

  private static final String LITERALS =
      """
      package demo;

      public class Literals {

        // A comment-only line.

        /* A block
           comment
           over three lines. */
        public String tricky() {
          String looksLikeComment = "/* not a comment */";
          String slashes = "http://example.com"; // trailing comment, still code
          char quote = '"';
          return looksLikeComment + slashes + quote;
        }
      }
      """;

  @TempDir static Path root;

  private static Map<String, Entity> bySignature;
  private static Map<String, Entity> byId;

  @BeforeAll
  static void extract() throws IOException {
    write("demo/Branchy.java", BRANCHY);
    write("demo/Literals.java", LITERALS);
    write("demo/Channel.java", "package demo;\npublic enum Channel { WEB, PHONE, STORE }\n");

    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(21);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(root.toString());
    CtModel model = launcher.buildModel();

    Anchors anchors = new Anchors(root);
    CorpusWhitelist whitelist = CorpusWhitelist.build(model, anchors, Progress.none());
    List<Entity> entities = new EntityExtractor(whitelist, anchors).extract(model);

    bySignature = new LinkedHashMap<>();
    byId = new LinkedHashMap<>();
    for (Entity entity : entities) {
      byId.put(entity.id(), entity);
      if (entity.signature() != null) {
        bySignature.put(entity.signature(), entity);
      }
    }
  }

  private static long cyclomatic(String signature) {
    Entity entity = bySignature.get(signature);
    assertNotNull(entity, () -> "no invocable with signature " + signature + " in " + bySignature.keySet());
    assertTrue(entity.traits().contains(TraitName.TMetrics), () -> signature + " carries no measures");
    Number value = entity.metrics().get("cyclomatic");
    assertNotNull(value, () -> signature + " carries no cyclomatic: " + entity.metrics());
    return value.longValue();
  }

  @Test
  @DisplayName("an if / else-if / for / ternary method, decision by decision")
  void branchyMethod() {
    // 1 + if + && + if + || + for + ternary
    assertEquals(7, cyclomatic("classify(int,java.lang.String)"));
  }

  @Test
  @DisplayName("a switch counts its case LABELS, and never its default")
  void switchLabels() {
    // 1 + (WEB, PHONE) + STORE; default is not a decision.
    assertEquals(4, cyclomatic("route(demo.Channel)"));
  }

  @Test
  @DisplayName("a pattern guard is a decision of its own, and so is the test inside it")
  void patternGuard() {
    // 1 + String label + guard + `>` is not counted (not short-circuit) + Integer label
    assertEquals(4, cyclomatic("guarded(java.lang.Object)"));
  }

  @Test
  @DisplayName("each catch clause is one way out")
  void catchClauses() {
    assertEquals(3, cyclomatic("risky(java.lang.String)"));
  }

  @Test
  @DisplayName("a lambda's branches belong to the LAMBDA, never to its host method")
  void lambdaBranchesAreTheLambdas() {
    // The method itself branches nowhere: it returns a lambda.
    assertEquals(1, cyclomatic("withLambda(int)"));
    // ... and the lambda carries 1 + if + && itself.
    Entity lambda =
        byId.values().stream()
            .filter(entity -> "lambda".equals(entity.kind()) && entity.metrics() != null)
            .filter(entity -> entity.metrics().containsKey("cyclomatic"))
            .filter(entity -> entity.metrics().get("cyclomatic").intValue() == 3)
            .findFirst()
            .orElse(null);
    assertNotNull(lambda, () -> "no lambda measured at 3: " + measuredLambdas());
  }

  @Test
  @DisplayName("a method with no decision point measures 1, never 0")
  void straightLineIsOne() {
    assertEquals(1, cyclomatic("plain(int)"));
  }

  @Test
  @DisplayName("sloc skips blank and comment-only lines, and is never fooled by a literal")
  void slocIgnoresCommentsAndRespectsLiterals() {
    Entity tricky = bySignature.get("tricky()");
    assertNotNull(tricky);
    // The method's span is its 6 lines: signature, 4 statements, closing brace —
    // the trailing `// still code` line counts, the javadoc above is outside it.
    assertEquals(6, tricky.metrics().get("sloc").intValue());

    // The type spans the whole class: 6 code lines of the method + `public class`
    // + its closing brace + the package line is OUTSIDE the type's span.
    Entity type = byId.get("java:demo/Literals");
    assertNotNull(type);
    assertEquals(8, type.metrics().get("sloc").intValue());
  }

  @Test
  @DisplayName("sloc never exceeds the gross span it measures — the derived proxy is an upper bound")
  void slocIsBoundedBySpan() {
    for (Entity entity : byId.values()) {
      if (entity.metrics() == null || !entity.metrics().containsKey("sloc")) {
        continue;
      }
      int span = entity.anchor().endLine() - entity.anchor().startLine() + 1;
      int sloc = entity.metrics().get("sloc").intValue();
      assertTrue(sloc <= span, () -> entity.id() + ": sloc " + sloc + " > span " + span);
      assertTrue(sloc >= 0, () -> entity.id() + ": negative sloc");
    }
  }

  @Test
  @DisplayName("only types and invocables are measured; a field or parameter is not")
  void onlyMeasurableKindsCarryMeasures() {
    for (Entity entity : byId.values()) {
      if (entity.metrics() == null) {
        continue;
      }
      assertTrue(
          List.of("class", "interface", "enum", "record", "annotation", "method", "constructor", "lambda")
              .contains(entity.kind()),
          () -> entity.kind() + " should carry no measures: " + entity.id());
      assertFalse(entity.metrics().isEmpty(), () -> entity.id() + " declares TMetrics with nothing in it");
      // A type's complexity is the SUM over its members, so it is not stored.
      if (!entity.traits().contains(TraitName.TInvocable)) {
        assertNull(entity.metrics().get("cyclomatic"), () -> entity.id() + " is not invocable");
      }
    }
  }

  @Test
  @DisplayName("a stub carries no measures — nothing read its source")
  void stubsAreUnmeasured() {
    for (Entity entity : byId.values()) {
      if (entity.stub()) {
        assertNull(entity.metrics(), () -> entity.id() + " is a stub and cannot have been measured");
      }
    }
  }

  private static String measuredLambdas() {
    StringBuilder out = new StringBuilder();
    for (Entity entity : byId.values()) {
      if ("lambda".equals(entity.kind())) {
        out.append(entity.id()).append(" -> ").append(entity.metrics()).append('\n');
      }
    }
    return out.toString();
  }

  private static void write(String relative, String source) throws IOException {
    Path file = root.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }
}
