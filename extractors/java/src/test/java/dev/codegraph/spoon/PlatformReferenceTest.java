package dev.codegraph.spoon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.Test;

/**
 * The platform library the extractor resolves {@code java.*} against.
 *
 * <p>ECJ borrows the class library of the JVM it runs inside, and a native image
 * has no JVM to borrow from. Without a replacement the extractor does not lose a
 * little precision, it starts INVENTING: {@code System.out.println(…)} emits a
 * type named {@code out}. So the build distils one from {@code ct.sym} and the
 * binary carries it. These tests pin the three claims that makes:
 *
 * <ul>
 *   <li>the build actually emitted it — an unbuilt reference is a silent 10-point
 *       drop in resolution, visible only as extra stub entities;
 *   <li>a JVM run never touches it, so {@code java -jar} behaviour is untouched;
 *   <li>only {@code java.base} is registered for reflection — registering the rest
 *       pulls AWT and sound natives in and the binary stops being one file.
 * </ul>
 */
class PlatformReferenceTest {

  private static final String JAR = "/dev/codegraph/spoon/java-api.jar";
  private static final String METADATA =
      "/META-INF/native-image/dev.codegraph/codegraph-java-platform/reachability-metadata.json";

  /** The agent-traced, committed half of the metadata — deleting it breaks the image, not a test. */
  private static final String TRACED =
      "/META-INF/native-image/dev.codegraph/codegraph-java/reachability-metadata.json";

  @Test
  void theBuildEmbedsTheReferenceJar() throws IOException {
    var entries = entriesOf(JAR);
    assertTrue(entries.contains("java/lang/String.class"), "no java.lang.String in the reference");
    assertTrue(entries.contains("java/util/List.class"), "no java.util.List in the reference");
    // Outside java.base: ECJ resolves it from the classpath even though the image
    // cannot Class.forName it — that asymmetry is deliberate, so pin it.
    assertTrue(entries.contains("java/sql/Time.class"), "no java.sql.Time in the reference");
    assertFalse(
        entries.contains("module-info.class"),
        "a module descriptor at the root would make ECJ read the jar as a module");
    assertTrue(entries.size() > 4000, "the reference looks truncated: " + entries.size() + " classes");
  }

  /**
   * On a JVM the reference is not consulted at all — {@code java.home} exists, ECJ
   * finds the platform library it always found, and the model is unchanged. This is
   * why adding the embedded reference did not move the committed snapshot.
   */
  @Test
  void aJvmRunNeverUnpacksTheReference() {
    assertNotNull(System.getProperty("java.home"), "these tests must run on a JVM");
    Optional<Path> reference = PlatformReference.forThisRuntime(Progress.none());
    assertTrue(reference.isEmpty(), "a JVM must keep using its own class library, not the embedded one");
  }

  /**
   * The reflection list is what lets {@code Class.forName} answer inside the image,
   * which is how Spoon — not ECJ — resolves an import. It is java.base and nothing
   * else: {@code java.awt} drags libawt/libfontmanager into the build and the
   * single-file binary becomes a directory of shared objects.
   */
  @Test
  void onlyJavaBaseIsRegisteredForReflection() throws IOException {
    String metadata = resource(METADATA);
    assertTrue(metadata.contains("\"java.lang.String\""), "java.base is not registered");
    assertTrue(metadata.contains("\"java.util.HashMap\""), "java.base is not registered");
    assertFalse(metadata.contains("\"java.awt."), "java.desktop would pull native libraries in");
    assertFalse(metadata.contains("\"javax.sound."), "java.desktop would pull native libraries in");
    assertFalse(metadata.contains("\"java.sql."), "only java.base is guaranteed to exist");
  }

  @Test
  void theTracedMetadataIsCommitted() throws IOException {
    String traced = resource(TRACED);
    assertTrue(
        traced.contains("org/eclipse/jdt/internal/compiler/parser/parser1.rsc"),
        "ECJ's parser tables are missing from the traced metadata — the image would fail at parse time");
  }

  /**
   * The reference must be the API of the release Main PARSES at, not the API of
   * whatever JDK happened to build it. ct.sym partitions by release, so the check
   * is what the set contains: a type introduced after the compliance level must be
   * absent, or the extractor would resolve code the corpus cannot legally contain.
   *
   * <p>(The class-file version stamped on a {@code .sig} is the build JDK's, not
   * the release's — it says nothing about which API surface this is.)
   */
  @Test
  void theReferenceIsTheReleaseMainParsesAt() throws IOException {
    assertEquals(17, Main.COMPLIANCE_LEVEL, "this test names Java 17's boundaries explicitly");
    var entries = entriesOf(JAR);
    assertTrue(entries.contains("java/lang/Record.class"), "Record is Java 16 — it must be here");
    assertFalse(
        entries.contains("java/util/SequencedCollection.class"),
        "SequencedCollection is Java 21 — a reference newer than the compliance level");
  }

  private static java.util.Set<String> entriesOf(String resource) throws IOException {
    var names = new java.util.HashSet<String>();
    try (InputStream in = open(resource);
        ZipInputStream zip = new ZipInputStream(in)) {
      for (ZipEntry entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
        names.add(entry.getName());
      }
    }
    return names;
  }

  private static String resource(String path) throws IOException {
    try (InputStream in = open(path)) {
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  private static InputStream open(String path) {
    InputStream in = PlatformReferenceTest.class.getResourceAsStream(path);
    assertNotNull(
        in,
        () ->
            path
                + " is missing — run ./mvnw package (the build generates it) or restore the"
                + " committed metadata");
    return in;
  }
}
