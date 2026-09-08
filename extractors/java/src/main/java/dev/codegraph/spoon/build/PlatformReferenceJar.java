package dev.codegraph.spoon.build;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * BUILD-TIME TOOL — distils {@code <jdk>/lib/ct.sym} into the platform reference
 * jar the extractor embeds. Never called at extraction time; {@link
 * dev.codegraph.spoon.PlatformReference} only reads what this wrote.
 *
 * <p>WHY THIS EXISTS. ECJ resolves {@code java.*} against a platform library, and
 * with no {@code -bootclasspath} it takes the one belonging to the JVM it runs
 * inside ({@code Util.getJavaHome()} → the VM bootclasspath). A native image has
 * no JVM and no {@code java.home}, so that library is simply absent — and an
 * extractor that cannot resolve {@code java.lang.String} does not degrade
 * gracefully, it invents: {@code System.out.println(…)} yields a type named
 * {@code out}, a type variable {@code T} becomes a stub entity. The C# extractor
 * met the same wall and embedded the BCL reference pack (PLAN.md §13.1); this is
 * the JVM's exact analogue.
 *
 * <p>WHY ct.sym AND NOT THE JDK ITSELF. {@code ct.sym} is what {@code javac
 * --release N} reads: signature-only class files, one frozen set per release, no
 * method bodies. The whole Java 17 public API is ~4,700 classes / ~2.3 MB, versus
 * ~130 MB for a JDK image. ECJ reads the {@code .sig} files as ordinary class
 * files once they are named {@code .class} — the format is the same, the code
 * attributes are just not there, and a compiler front end never needed them.
 *
 * <p>ct.sym's layout is a set of top-level directories whose NAME IS THE SET OF
 * RELEASES a signature is valid for, spelled as one character each ({@code 8},
 * {@code 9}, then {@code A}=10 … {@code H}=17). A class appears under exactly one
 * such directory, so "the API of release N" is the union of every directory whose
 * name contains N's character. {@code module-info} is excluded on purpose: the
 * jar is consumed as a flat classpath entry, and a module descriptor at the root
 * would invite ECJ to read it as a module rather than as plain types.
 *
 * <p>THE SECOND OUTPUT, and why a jar alone is not enough. Spoon resolves an
 * IMPORT through the runtime classloader, not through ECJ's classpath — proved by
 * running the jar under {@code --limit-modules java.base}, which flips exactly the
 * {@code java.sql.*} imports from {@code declared} to {@code derived} while ECJ
 * still sees them. A native image can only load classes compiled into it, so the
 * types must also be registered as reachability metadata. That list is
 * {@code java.base} ONLY: the one module every Java runtime has, and the one whose
 * types drag no native library into the image. Registering the rest pulls AWT,
 * fontmanager and sound in and the build stops being a single file — the whole
 * point of shipping a binary.
 *
 * <p>The residual is exact and small: an import of a type outside {@code java.base}
 * (e.g. {@code java.sql.Timestamp}) is labelled {@code derived} rather than
 * {@code declared} — the package it points at is unchanged, and it is the same
 * answer a JVM limited to {@code java.base} gives. Entities are unaffected.
 *
 * <p>Both outputs are byte-reproducible — entries sorted, one fixed timestamp — so
 * rebuilding them is a no-op in a diff and the extractor's own determinism property
 * extends to the library it resolves against.
 */
public final class PlatformReferenceJar {

  /** ZIP cannot express an epoch before 1980; this is the conventional stand-in. */
  private static final FileTime FIXED_TIME = FileTime.from(Instant.parse("1980-01-01T00:00:00Z"));

  private PlatformReferenceJar() {}

  /** The only module guaranteed to exist, and the only one that needs no native library. */
  static final String REFLECTIVE_MODULE = "java.base";

  /**
   * {@code PlatformReferenceJar <release> <output.jar> <metadata.json>} — ct.sym
   * comes from the build JDK.
   */
  public static void main(String[] args) throws IOException {
    if (args.length != 3) {
      System.err.println("usage: PlatformReferenceJar <release> <output.jar> <metadata.json>");
      System.exit(2);
      return;
    }
    int release = Integer.parseInt(args[0]);
    Path jar = Path.of(args[1]);
    Path metadata = Path.of(args[2]);

    Path ctSym = ctSymOfBuildJdk();
    Signatures signatures = read(ctSym, release);
    writeJar(signatures, jar);
    int registered = writeMetadata(signatures, metadata);
    System.out.println(
        "platform reference: java "
            + release
            + " API, "
            + signatures.classes.size()
            + " classes -> "
            + jar
            + " ("
            + registered
            + " from "
            + REFLECTIVE_MODULE
            + " registered for reflection)");
  }

  /** Every signature of one release, plus which of them belong to {@link #REFLECTIVE_MODULE}. */
  record Signatures(Map<String, byte[]> classes, java.util.Set<String> reflective) {}

  /**
   * The build JDK's own {@code ct.sym}. A JDK ships signatures for its own release
   * and roughly the twenty before it, so any modern JDK can produce the Java 17
   * set; a JRE ships none, which is why the message names the file rather than the
   * symptom.
   */
  static Path ctSymOfBuildJdk() {
    String home = System.getProperty("java.home");
    if (home == null) {
      throw new IllegalStateException("no java.home — this tool must run on a JDK");
    }
    Path ctSym = Path.of(home, "lib", "ct.sym");
    if (!Files.isRegularFile(ctSym)) {
      throw new IllegalStateException(
          "no " + ctSym + " — the platform reference jar needs a JDK, not a JRE");
    }
    return ctSym;
  }

  /**
   * Collects release {@code release}'s signatures out of {@code ctSym}. An unknown
   * release yields no directories rather than an error, so an empty result is the
   * only signal that the build JDK cannot serve this release at all.
   */
  static Signatures read(Path ctSym, int release) throws IOException {
    char marker = releaseMarker(release);
    // Sorted by entry name: the jar is an input to a model that must be
    // byte-reproducible, so its own byte order cannot depend on directory reads.
    Map<String, byte[]> classes = new TreeMap<>();
    java.util.Set<String> reflective = new java.util.TreeSet<>();

    try (FileSystem zip = FileSystems.newFileSystem(ctSym)) {
      for (Path root : zip.getRootDirectories()) {
        try (var releases = Files.newDirectoryStream(root)) {
          for (Path releaseDir : releases) {
            if (!Files.isDirectory(releaseDir)) {
              continue;
            }
            String name = releaseDir.getFileName().toString().replace("/", "");
            if (name.indexOf(marker) < 0) {
              continue;
            }
            collect(releaseDir, classes, reflective);
          }
        }
      }
    }

    if (classes.isEmpty()) {
      throw new IllegalStateException(
          "no signatures for release " + release + " in " + ctSym + " — is this JDK too new?");
    }
    return new Signatures(classes, reflective);
  }

  /** The reference jar itself: what ECJ resolves types against. */
  static void writeJar(Signatures signatures, Path output) throws IOException {
    createParent(output);
    try (ZipOutputStream out = new ZipOutputStream(Files.newOutputStream(output))) {
      for (Map.Entry<String, byte[]> entry : signatures.classes().entrySet()) {
        ZipEntry zipEntry = new ZipEntry(entry.getKey());
        zipEntry.setLastModifiedTime(FIXED_TIME);
        zipEntry.setCreationTime(FIXED_TIME);
        zipEntry.setLastAccessTime(FIXED_TIME);
        out.putNextEntry(zipEntry);
        out.write(entry.getValue());
        out.closeEntry();
      }
    }
  }

  /**
   * GraalVM reachability metadata naming every {@link #REFLECTIVE_MODULE} type, so
   * {@code Class.forName} answers for them inside a native image the way it does on
   * a JVM. Written by hand rather than emitted by the tracing agent because no
   * traced run can enumerate the types a FUTURE corpus will import — the agent
   * records what one run touched, and this is a closed set known at build time.
   *
   * <p>Types only, no members: Spoon asks whether the name resolves and which
   * package it lands in, never for its methods.
   */
  static int writeMetadata(Signatures signatures, Path output) throws IOException {
    createParent(output);
    StringBuilder json = new StringBuilder("{\n  \"reflection\": [\n");
    int i = 0;
    for (String type : signatures.reflective()) {
      json.append("    { \"type\": \"").append(type).append("\" }");
      json.append(++i == signatures.reflective().size() ? "\n" : ",\n");
    }
    json.append("  ]\n}\n");
    Files.writeString(output, json.toString());
    return signatures.reflective().size();
  }

  private static void createParent(Path output) throws IOException {
    Path parent = output.toAbsolutePath().getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
  }

  /**
   * One release directory: {@code <releases>/<module>/<package…>/<Name>.sig}. The
   * module segment is dropped — a classpath has no modules — and the first writer
   * of a name wins, which is well defined because the map is filled in sorted
   * directory order and a signature belongs to exactly one release directory.
   */
  private static void collect(
      Path releaseDir, Map<String, byte[]> classes, java.util.Set<String> reflective)
      throws IOException {
    try (var modules = Files.newDirectoryStream(releaseDir)) {
      for (Path module : modules) {
        if (!Files.isDirectory(module)) {
          continue;
        }
        Files.walkFileTree(
            module,
            new SimpleFileVisitor<Path>() {
              @Override
              public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                  throws IOException {
                String relative = module.relativize(file).toString();
                if (!relative.endsWith(".sig")) {
                  return FileVisitResult.CONTINUE;
                }
                String entry = relative.substring(0, relative.length() - 4) + ".class";
                if (entry.equals("module-info.class")) {
                  return FileVisitResult.CONTINUE;
                }
                classes.putIfAbsent(entry, Files.readAllBytes(file));
                if (module.getFileName().toString().replace("/", "").equals(REFLECTIVE_MODULE)) {
                  reflective.add(entry.substring(0, entry.length() - 6).replace("/", "."));
                }
                return FileVisitResult.CONTINUE;
              }
            });
      }
    }
  }

  /** ct.sym's per-release character: {@code 8}, {@code 9}, then {@code A}=10 onward. */
  static char releaseMarker(int release) {
    if (release < 8) {
      throw new IllegalArgumentException("release " + release + " predates ct.sym");
    }
    if (release <= 9) {
      return (char) ('0' + release);
    }
    char marker = (char) ('A' + release - 10);
    if (marker > 'Z') {
      throw new IllegalArgumentException("release " + release + " is past ct.sym's letter scheme");
    }
    return marker;
  }
}
