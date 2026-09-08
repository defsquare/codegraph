package dev.codegraph.spoon;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/**
 * The Java platform library ECJ resolves {@code java.*} against — and what to do
 * when the running executable has none.
 *
 * <p>ECJ, given no {@code -bootclasspath}, reads the class library of the JVM it
 * runs inside ({@code Util.getJavaHome()} → {@code collectVMBootclasspath}). That
 * is invisible in a {@code java -jar} run and correct there. A GraalVM native
 * image is not inside a JVM: {@code java.home} is null, there is no boot
 * classpath, and Spoon's noClasspath mode does NOT degrade gracefully — with no
 * {@code java.lang}, {@code System.out.println(…)} produces a stub type named
 * {@code out} and a type variable {@code T} becomes an entity. Measured on
 * {@code fixtures/java/src}: 84.9% resolution and 40 stubs, against 94.5% and 27.
 *
 * <p>So the native image carries its own: {@code java-api.jar}, the public API of
 * the release Main compiles against, distilled from a JDK's {@code ct.sym} at
 * build time ({@link dev.codegraph.spoon.build.PlatformReferenceJar}).
 * It is handed to Spoon as the source classpath, which ECJ searches LAST —
 * bootclasspath, extdirs, sourcepath, then classpath. That ordering is the whole
 * design: on a JVM the VM's own library still wins and behaviour is untouched; in
 * a native image nothing precedes it, so it becomes the platform library.
 *
 * <p>Both paths therefore resolve against a real Java 17 API, and the extractor
 * emits the same model either way — which the published-binary snapshot test
 * pins.
 */
final class PlatformReference {

  /** Written into {@code target/classes} by the build; absent from a plain source checkout. */
  private static final String RESOURCE = "/dev/codegraph/spoon/java-api.jar";

  private PlatformReference() {}

  /**
   * The reference jar this runtime needs, or empty when it needs none.
   *
   * <p>Empty is the JVM case: {@code java.home} names a real directory, so ECJ
   * finds the platform library the way it always has and nothing is unpacked.
   */
  static Optional<Path> forThisRuntime(Progress progress) {
    if (hasPlatformLibrary()) {
      return Optional.empty();
    }

    // ECJ dereferences getJavaHome() unconditionally in handleExtdirs when
    // java.ext.dirs is unset — an NPE before any of our code runs again. The
    // property is a JDK 8 relic with no meaning here, and empty means "no
    // extension directories", which is the truth.
    if (System.getProperty("java.ext.dirs") == null) {
      System.setProperty("java.ext.dirs", "");
    }

    Optional<Path> jar = unpack();
    if (jar.isEmpty()) {
      progress.log(
          "warning: no embedded platform reference and no java.home — java.* types will not "
              + "resolve and the model will contain entities the corpus does not declare");
    }
    return jar;
  }

  /**
   * Mirrors ECJ's own test ({@code Util.getJavaHome}): a non-null {@code java.home}
   * naming a directory that exists. Deliberately not stricter — anything ECJ
   * accepts, this must accept, or the two disagree about which library is in use.
   */
  private static boolean hasPlatformLibrary() {
    String home = System.getProperty("java.home");
    return home != null && !home.isBlank() && Files.isDirectory(Path.of(home));
  }

  /**
   * Materialises the embedded jar beside the temp directory, named by its own
   * digest so a second run reuses it and a changed build can never be served a
   * stale file. ECJ opens classpath entries as files, so a classloader resource is
   * not enough — it has to exist on disk.
   */
  private static Optional<Path> unpack() {
    byte[] bytes;
    try (InputStream in = PlatformReference.class.getResourceAsStream(RESOURCE)) {
      if (in == null) {
        return Optional.empty();
      }
      bytes = in.readAllBytes();
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read the embedded platform reference", e);
    }

    Path cached =
        Path.of(System.getProperty("java.io.tmpdir"))
            .resolve("codegraph-java-api-" + digest(bytes) + ".jar");
    if (Files.isRegularFile(cached)) {
      return Optional.of(cached);
    }

    try {
      // Written elsewhere and moved into place: two extractions racing must never
      // let a third read a half-written jar.
      Path partial = Files.createTempFile(cached.getParent(), "codegraph-java-api-", ".part");
      Files.write(partial, bytes);
      try {
        Files.move(partial, cached, StandardCopyOption.ATOMIC_MOVE);
      } catch (IOException alreadyThere) {
        Files.deleteIfExists(partial);
        if (!Files.isRegularFile(cached)) {
          throw alreadyThere;
        }
      }
    } catch (IOException e) {
      throw new UncheckedIOException("cannot unpack the embedded platform reference", e);
    }
    return Optional.of(cached);
  }

  private static String digest(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes), 0, 8);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is mandatory on every Java platform", e);
    }
  }
}
