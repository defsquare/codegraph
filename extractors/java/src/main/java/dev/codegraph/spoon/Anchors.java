package dev.codegraph.spoon;

import dev.codegraph.spoon.model.SourceAnchor;
import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;

/**
 * Turns Spoon positions into {@link SourceAnchor}s, root-relative and 1-based.
 *
 * <p>Two Spoon facts make this worth centralizing rather than repeating in each
 * extraction pass: {@code getPosition()} may return an invalid position for
 * synthetic or implicit elements (checking {@code isValidPosition()} first is
 * mandatory), and an anchor is REQUIRED on every edge — so when an element has
 * no position of its own, {@link #orEnclosing} walks up to the nearest ancestor
 * that has one instead of inventing a line.
 *
 * <p>Paths are relativized against the model's {@code root} so that ids and
 * anchors are stable across machines.
 */
public final class Anchors {

  private final Path root;

  /** Relativization hits the filesystem (see {@link #canonical}); a corpus has far more elements than files. */
  private final Map<Path, String> relativeByFile = new HashMap<>();

  public Anchors(Path root) {
    this.root = canonical(root);
  }

  /**
   * Symlinks resolved, so a path from Spoon and a path from the command line are
   * comparable. Spoon reports real paths; a {@code --src} argument usually is not
   * one (on macOS {@code /tmp} and {@code /var} are symlinks), and comparing the
   * two forms directly fails, leaking absolute machine-specific paths into anchors
   * and into the lambda/anonymous ids that embed a file path.
   */
  static Path canonical(Path path) {
    Path absolute = path.toAbsolutePath().normalize();
    try {
      return absolute.toRealPath();
    } catch (IOException notOnDisk) {
      return absolute;
    }
  }

  public Path root() {
    return root;
  }

  /** Empty when the element has no valid position — never guess one. */
  public Optional<SourceAnchor> of(CtElement element) {
    if (element == null) {
      return Optional.empty();
    }
    SourcePosition position = element.getPosition();
    if (position == null || !position.isValidPosition()) {
      return Optional.empty();
    }
    String file = relativeFile(position);
    if (file == null) {
      return Optional.empty();
    }
    int start = Math.max(1, position.getLine());
    int end = Math.max(start, position.getEndLine());
    return Optional.of(SourceAnchor.of(file, start, end));
  }

  /**
   * The element's own anchor, or the nearest enclosing element's. Empty only if
   * nothing up the chain carries a position, in which case the caller must drop
   * the fact rather than emit an edge without evidence.
   */
  public Optional<SourceAnchor> orEnclosing(CtElement element) {
    CtElement current = element;
    for (int guard = 0; guard < 256 && current != null; guard++) {
      Optional<SourceAnchor> anchor = of(current);
      if (anchor.isPresent()) {
        return anchor;
      }
      current = current.getParent();
    }
    return Optional.empty();
  }

  /** Root-relative path of the file an element was written in, or null. */
  public String relativeFile(CtElement element) {
    if (element == null) {
      return null;
    }
    SourcePosition position = element.getPosition();
    return (position == null || !position.isValidPosition()) ? null : relativeFile(position);
  }

  /**
   * Root-relative path of a file named by something other than a Spoon element —
   * the JDT compiler reports the declarations it discarded by filename only.
   */
  public String relativeFile(Path file) {
    return file == null ? null : relativeByFile.computeIfAbsent(file, this::relativize);
  }

  private String relativeFile(SourcePosition position) {
    File file = position.getFile();
    if (file == null && position.getCompilationUnit() != null) {
      file = position.getCompilationUnit().getFile();
    }
    if (file == null) {
      return null;
    }
    return relativeByFile.computeIfAbsent(file.toPath(), this::relativize);
  }

  private String relativize(Path file) {
    Path absolute = canonical(file);
    Path relative = absolute.startsWith(root) ? root.relativize(absolute) : absolute;
    // Forward slashes always: the model must not differ between platforms.
    return relative.toString().replace(File.separatorChar, '/');
  }
}
