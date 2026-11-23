package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.codegraph.spoon.model.Edge;
import dev.codegraph.spoon.model.EdgeKind;
import dev.codegraph.spoon.model.Provenance;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.Launcher;
import spoon.reflect.CtModel;

/**
 * A lambda whose functional interface is not on the classpath is a body ECJ never
 * resolves: Spoon hands every call in it over with no declaring type and no
 * parameter types. An unqualified call there still names one method by the
 * language's own lookup — the innermost enclosing type with a member of that name,
 * then arity — and must reach it, or the callee looks uncalled and every call
 * chain stops at the lambda (found on spring-petclinic's CacheConfiguration).
 *
 * <p>The real pass 1 builds the whitelist here, so what is asserted is what the
 * extractor would write.
 */
class UnboundLambdaCallTest {

  private static final String PACKAGE = "java:com.acme.cache/";
  private static final String SETUP = PACKAGE + "CacheSetup";
  private static final String SETUP_FILE = "com/acme/cache/CacheSetup.java";
  private static final String ADAPTER = PACKAGE + "AdapterSetup";
  private static final String ADAPTER_FILE = "com/acme/cache/AdapterSetup.java";
  private static final String SUB = PACKAGE + "SubSetup";
  private static final String SUB_FILE = "com/acme/cache/SubSetup.java";

  /** {@code CacheCustomizer} and {@code CacheRegistry} are deliberately not on any classpath. */
  private static final String CACHE_SETUP =
      """
      package com.acme.cache;

      import com.nonexistent.cache.CacheCustomizer;
      import com.nonexistent.cache.CacheRegistry;
      import java.util.function.Consumer;

      public class CacheSetup {

        public CacheCustomizer argumentOfAnUnresolvedCall() {
          return cm -> cm.createCache("vets", configuration());
        }

        public CacheCustomizer plainCall() {
          return cm -> warmUp();
        }

        public CacheCustomizer nestedLambda() {
          return cm -> {
            Consumer<String> inner = name -> preload(name);
          };
        }

        public CacheCustomizer arityDecides() {
          return cm -> evict("vets", 1);
        }

        public CacheCustomizer varargs() {
          return cm -> register("a", "b", "c");
        }

        public CacheCustomizer sameArityOverloads() {
          return cm -> touch("vets");
        }

        public void typedReceiver(CacheRegistry registry) {
          registry.createCache("vets", configurationOfTypedCall());
        }

        public Consumer<String> knownInterface() {
          return name -> warmUpKnown();
        }

        Object configuration() { return null; }
        Object configurationOfTypedCall() { return null; }
        void warmUp() {}
        void warmUpKnown() {}
        void preload(String name) {}
        void evict(String name) {}
        void evict(String name, int times) {}
        void register(String... names) {}
        void touch(String name) {}
        void touch(Integer id) {}
        void outerHelper() {}

        class Inner {
          CacheCustomizer fromInner() {
            return cm -> outerHelper();
          }
        }
      }
      """;

  /** A superclass the corpus cannot show: it may declare another one-argument {@code configure}. */
  private static final String ADAPTER_SETUP =
      """
      package com.acme.cache;

      import com.nonexistent.cache.CacheCustomizer;
      import com.nonexistent.cache.ExternalAdapter;

      public class AdapterSetup extends ExternalAdapter {

        public CacheCustomizer customize() {
          return cm -> configure(cm);
        }

        void configure(Object cm) {}
      }
      """;

  /** A superclass the corpus declares: its members are all visible. */
  private static final String SUB_SETUP =
      """
      package com.acme.cache;

      import com.nonexistent.cache.CacheCustomizer;

      public class SubSetup extends CacheSetup {

        public CacheCustomizer inherited() {
          return cm -> outerHelper();
        }
      }
      """;

  // ------------------------------------------------------------- the defect

  @Test
  void aPlainCallInAnUnresolvedLambdaReachesTheEnclosingMethod(@TempDir Path root) throws IOException {
    Edge edge = callFromLambda(extract(root), SETUP, SETUP_FILE, "    return cm -> warmUp();", SETUP + ".warmUp()");
    assertEquals(Provenance.DECLARED, edge.provenance());
    assertEquals(lineOf(CACHE_SETUP, "    return cm -> warmUp();"), edge.anchor().startLine());
  }

  @Test
  void aCallPassedToAnUnresolvedCallInAnUnresolvedLambdaReachesTheEnclosingMethod(@TempDir Path root)
      throws IOException {
    Edge edge =
        callFromLambda(
            extract(root),
            SETUP,
            SETUP_FILE,
            "    return cm -> cm.createCache(\"vets\", configuration());",
            SETUP + ".configuration()");
    assertEquals(Provenance.DECLARED, edge.provenance());
  }

  /** The controls: both were already right, and must stay exactly so. */
  @Test
  void callsEcjResolvedAreUnchanged(@TempDir Path root) throws IOException {
    List<Edge> edges = extract(root).edges();
    Edge typed =
        single(
            edges,
            SETUP + ".typedReceiver(com.nonexistent.cache.CacheRegistry)",
            SETUP + ".configurationOfTypedCall()");
    assertEquals(Provenance.DECLARED, typed.provenance());
    Edge known =
        callFromLambda(
            new Extraction(edges, 0), SETUP, SETUP_FILE, "    return name -> warmUpKnown();", SETUP + ".warmUpKnown()");
    assertEquals(Provenance.DECLARED, known.provenance());
  }

  // ------------------------------------------- what the lookup decides, and how

  /** A lambda nested in an unresolved one is unresolved too, whatever its own interface. */
  @Test
  void aNestedLambdaInsideAnUnresolvedOneIsResolvedTheSameWay(@TempDir Path root) throws IOException {
    Edge edge =
        callFromLambda(
            extract(root),
            SETUP,
            SETUP_FILE,
            "      Consumer<String> inner = name -> preload(name);",
            SETUP + ".preload(java.lang.String)");
    assertEquals(Provenance.DECLARED, edge.provenance());
  }

  @Test
  void arityPicksTheOneOverloadThatCanApply(@TempDir Path root) throws IOException {
    Extraction extraction = extract(root);
    callFromLambda(
        extraction, SETUP, SETUP_FILE, "    return cm -> evict(\"vets\", 1);", SETUP + ".evict(java.lang.String,int)");
    callFromLambda(
        extraction,
        SETUP,
        SETUP_FILE,
        "    return cm -> register(\"a\", \"b\", \"c\");",
        SETUP + ".register(java.lang.String[])");
  }

  /** Two overloads of the same arity need the argument types ECJ never computed. */
  @Test
  void sameArityOverloadsAreDroppedAndCountedNeverGuessed(@TempDir Path root) throws IOException {
    Extraction extraction = extract(root);
    String lambda = lambdaPrefix(SETUP, SETUP_FILE, "    return cm -> touch(\"vets\");");
    assertTrue(
        extraction.edges().stream().noneMatch(e -> e.from().startsWith(lambda) && e.edge() == EdgeKind.INVOCATION),
        () -> "an ambiguous overload was resolved: " + extraction.edges());
    assertTrue(extraction.droppedUnidentifiedTargets() >= 1, "the dropped call is counted");
  }

  /** JLS §15.12.1: the innermost enclosing type with a member of that name — here the outer class. */
  @Test
  void aCallInAnInnerClassLambdaReachesTheOuterClass(@TempDir Path root) throws IOException {
    Edge edge =
        callFromLambda(
            extract(root), SETUP + ".Inner", SETUP_FILE, "      return cm -> outerHelper();", SETUP + ".outerHelper()");
    assertEquals(Provenance.DECLARED, edge.provenance());
  }

  @Test
  void aMethodInheritedFromACorpusSuperclassIsAsVisibleAsADeclaredOne(@TempDir Path root) throws IOException {
    Edge edge =
        callFromLambda(extract(root), SUB, SUB_FILE, "    return cm -> outerHelper();", SETUP + ".outerHelper()");
    assertEquals(Provenance.DECLARED, edge.provenance());
  }

  /**
   * The superclass is not in the corpus, so an overload the lookup cannot see may
   * be the real target: the edge is an inference, and says so.
   */
  @Test
  void aSuperclassOutsideTheCorpusMakesTheTargetDerived(@TempDir Path root) throws IOException {
    Edge edge =
        callFromLambda(
            extract(root), ADAPTER, ADAPTER_FILE, "    return cm -> configure(cm);", ADAPTER + ".configure(java.lang.Object)");
    assertEquals(Provenance.DERIVED, edge.provenance());
  }

  // -------------------------------------------------------------- fixtures

  private record Extraction(List<Edge> edges, int droppedUnidentifiedTargets) {}

  private static Extraction extract(Path root) throws IOException {
    write(root, SETUP_FILE, CACHE_SETUP);
    write(root, ADAPTER_FILE, ADAPTER_SETUP);
    write(root, SUB_FILE, SUB_SETUP);
    Launcher launcher = new Launcher();
    launcher.getEnvironment().setNoClasspath(true);
    launcher.getEnvironment().setComplianceLevel(17);
    launcher.getEnvironment().setCommentEnabled(true);
    launcher.addInputResource(root.toString());
    CtModel model = launcher.buildModel();
    Anchors anchors = new Anchors(root);
    EdgeExtractor extractor = new EdgeExtractor(CorpusWhitelist.build(model, anchors), anchors);
    List<Edge> edges = extractor.extract(model);
    return new Extraction(edges, extractor.droppedUnidentifiedTargets());
  }

  /** The one invocation from the lambda written on {@code line} to {@code to}. */
  private static Edge callFromLambda(Extraction extraction, String type, String file, String line, String to) {
    String lambda = lambdaPrefix(type, file, line);
    List<Edge> matches =
        extraction.edges().stream()
            .filter(e -> e.edge() == EdgeKind.INVOCATION && e.from().startsWith(lambda) && e.to().equals(to))
            .toList();
    if (matches.size() != 1) {
      throw new AssertionError(
          "expected one invocation " + lambda + "… -> " + to + ", got " + matches.size() + " among\n"
              + String.join("\n", extraction.edges().stream().filter(e -> e.edge() == EdgeKind.INVOCATION)
                  .map(e -> e.from() + " -> " + e.to() + " [" + e.provenance().json() + "]").toList())
              + "\n(dropped unidentified targets: " + extraction.droppedUnidentifiedTargets() + ")");
    }
    return matches.get(0);
  }

  private static Edge single(List<Edge> edges, String from, String to) {
    List<Edge> matches =
        edges.stream()
            .filter(e -> e.edge() == EdgeKind.INVOCATION && e.from().equals(from) && e.to().equals(to))
            .toList();
    assertEquals(1, matches.size(), () -> "invocations " + from + " -> " + to + ": " + matches);
    return matches.get(0);
  }

  /** A lambda's id is {@code <enclosing type>#<file>:<line>:<column>}; the column is the source's business. */
  private static String lambdaPrefix(String type, String file, String line) {
    String source =
        switch (file) {
          case SETUP_FILE -> CACHE_SETUP;
          case ADAPTER_FILE -> ADAPTER_SETUP;
          case SUB_FILE -> SUB_SETUP;
          default -> throw new AssertionError("unknown file " + file);
        };
    return type + "#" + file + ":" + lineOf(source, line) + ":";
  }

  private static int lineOf(String source, String text) {
    List<String> lines = List.of(source.split("\n", -1));
    for (int i = 0; i < lines.size(); i++) {
      if (lines.get(i).equals(text)) {
        return i + 1;
      }
    }
    throw new AssertionError("no line [" + text + "]");
  }

  private static void write(Path root, String relative, String source) throws IOException {
    Path file = root.resolve(relative);
    Files.createDirectories(file.getParent());
    Files.writeString(file, source);
  }
}
