package dev.codegraph.spoon.build;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The build-time distillation of {@code ct.sym}. What it produces is an INPUT to a
 * model whose byte-for-byte determinism is a tested property, so the tool's own
 * output has to be reproducible before anything downstream can be.
 *
 * <p>{@code maven.compiler.release} owns the release number, so these tests read
 * the release from the same place the pom does rather than restating it: the
 * compiled class file this test itself runs as.
 */
class PlatformReferenceJarTest {

  /** The release the whole module is compiled at — 44 + release IS the class-file major. */
  private static final int RELEASE = classFileMajorOfThisTest() - 44;

  @Test
  void theSameCtSymAlwaysProducesTheSameBytes(@TempDir Path directory) throws IOException {
    var signatures = PlatformReferenceJar.read(PlatformReferenceJar.ctSymOfBuildJdk(), RELEASE);

    Path first = directory.resolve("first.jar");
    Path second = directory.resolve("second.jar");
    PlatformReferenceJar.writeJar(signatures, first);
    PlatformReferenceJar.writeJar(signatures, second);
    assertTrue(
        Arrays.equals(Files.readAllBytes(first), Files.readAllBytes(second)),
        "two runs of the reference build differ — the model's determinism rests on this");
  }

  @Test
  void theReflectiveSetIsJavaBaseAndOnlyJavaBase() throws IOException {
    var signatures = PlatformReferenceJar.read(PlatformReferenceJar.ctSymOfBuildJdk(), RELEASE);

    assertTrue(signatures.reflective().contains("java.lang.String"));
    assertTrue(signatures.reflective().contains("java.util.HashMap"));
    // In the jar (ECJ can resolve it), out of the reflective set (the image would
    // have to carry java.sql, and with it the modules that need native libraries).
    assertTrue(signatures.classes().containsKey("java/sql/Time.class"));
    assertFalse(signatures.reflective().contains("java.sql.Time"));
    assertFalse(
        signatures.reflective().stream().anyMatch(type -> type.startsWith("java.awt.")),
        "java.desktop in the image means libawt beside the binary");
  }

  @Test
  void theMetadataNamesEveryReflectiveTypeExactlyOnce(@TempDir Path directory) throws IOException {
    var signatures = PlatformReferenceJar.read(PlatformReferenceJar.ctSymOfBuildJdk(), RELEASE);
    Path metadata = directory.resolve("reachability-metadata.json");

    int registered = PlatformReferenceJar.writeMetadata(signatures, metadata);
    String json = Files.readString(metadata);

    assertEquals(signatures.reflective().size(), registered);
    assertEquals(registered, json.split("\"type\"", -1).length - 1, "duplicate or missing entries");
    assertTrue(json.contains("\"java.lang.Object\""));
  }

  /** ct.sym spells a release as one character: 8, 9, then A=10 onward. */
  @Test
  void releasesMapToCtSymCharacters() {
    assertEquals('8', PlatformReferenceJar.releaseMarker(8));
    assertEquals('9', PlatformReferenceJar.releaseMarker(9));
    assertEquals('A', PlatformReferenceJar.releaseMarker(10));
    assertEquals('H', PlatformReferenceJar.releaseMarker(17));
    assertEquals('L', PlatformReferenceJar.releaseMarker(21));
    assertThrows(IllegalArgumentException.class, () -> PlatformReferenceJar.releaseMarker(7));
  }

  private static int classFileMajorOfThisTest() {
    try (var in =
        PlatformReferenceJarTest.class.getResourceAsStream("PlatformReferenceJarTest.class")) {
      byte[] header = in.readNBytes(8);
      return ((header[6] & 0xff) << 8) | (header[7] & 0xff);
    } catch (IOException e) {
      throw new IllegalStateException("cannot read this test's own class file", e);
    }
  }
}
