package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Comparator;
import java.util.List;

/**
 * A relation, stored once and in the outgoing direction only (METAMODEL.md §4).
 * Inverse views (callers-of, subtypes-of, importers-of) are derived by the
 * analyzer and never serialized.
 *
 * <p>Every edge carries {@code provenance} (never mix facts and inferences) and
 * an {@code anchor} (evidence). Both are required by the schema — there is no
 * factory here that lets you omit either.
 *
 * <p>Factories exist only for the six kinds the Java profile licenses. {@code
 * isRead}/{@code isWrite} are reachable only through {@link #access}, which is
 * the only kind whose schema variant requires them.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"edge", "from", "to", "provenance", "anchor", "candidates", "arguments", "isRead", "isWrite", "sourceFile"})
public record Edge(
    EdgeKind edge,
    String from,
    String to,
    Provenance provenance,
    SourceAnchor anchor,
    List<String> candidates,
    /** annotationUse only: the written arguments, in written order (§1.6). */
    List<NamedArgument> arguments,
    @JsonProperty("isRead") Boolean isRead,
    @JsonProperty("isWrite") Boolean isWrite,
    String sourceFile) {

  public Edge {
    requireText(from, "edge from");
    requireText(to, "edge to");
    if (edge == null) {
      throw new IllegalArgumentException("edge kind is required");
    }
    if (provenance == null) {
      throw new IllegalArgumentException("provenance is required on every edge");
    }
    if (anchor == null) {
      throw new IllegalArgumentException("an anchor is required on every edge (evidence)");
    }
    candidates = candidates == null ? null : List.copyOf(candidates);
    arguments = arguments == null ? null : List.copyOf(arguments);
    if ((edge == EdgeKind.ANNOTATION_USE) != (arguments != null)) {
      throw new IllegalArgumentException(
          "an annotationUse edge carries an argument list (possibly empty) and no other kind does");
    }
  }

  /** Module → Module. The first-class, cross-language comparable layer. */
  public static Edge importEdge(String from, String to, Provenance provenance, SourceAnchor anchor) {
    return new Edge(EdgeKind.IMPORT, from, to, provenance, anchor, null, null, null, null, null);
  }

  /** Type → Type: {@code extends} (classes and interfaces alike). */
  public static Edge inheritance(String from, String to, Provenance provenance, SourceAnchor anchor) {
    return new Edge(EdgeKind.INHERITANCE, from, to, provenance, anchor, null, null, null, null, null);
  }

  /** Type → interface: a class/enum/record {@code implements} clause. */
  public static Edge interfaceImplementation(
      String from, String to, Provenance provenance, SourceAnchor anchor) {
    return new Edge(EdgeKind.INTERFACE_IMPLEMENTATION, from, to, provenance, anchor, null, null, null, null, null);
  }

  /**
   * Invocable → Invocable. {@code candidates} is non-empty only when dispatch
   * was genuinely ambiguous, and such an edge belongs with provenance
   * {@link Provenance#DYNAMIC_CANDIDATE}.
   */
  public static Edge invocation(
      String from, String to, Provenance provenance, SourceAnchor anchor, List<String> candidates) {
    List<String> cands = (candidates == null || candidates.isEmpty()) ? null : candidates;
    return new Edge(EdgeKind.INVOCATION, from, to, provenance, anchor, cands, null, null, null, null);
  }

  /** Invocable → Structural. At least one of read/write must be true. */
  public static Edge access(
      String from,
      String to,
      Provenance provenance,
      SourceAnchor anchor,
      boolean isRead,
      boolean isWrite) {
    if (!isRead && !isWrite) {
      throw new IllegalArgumentException("an access that is neither a read nor a write is not an access");
    }
    return new Edge(EdgeKind.ACCESS, from, to, provenance, anchor, null, null, isRead, isWrite, null);
  }

  /**
   * Entity → annotation Type: a WRITTEN annotation, with its arguments (§1.6).
   * A kind of its own rather than a `reference` because it carries the values,
   * and because a consumer must be able to select annotation usages without
   * inspecting the target's kind — which a stub target cannot answer.
   */
  public static Edge annotationUse(
      String from, String to, Provenance provenance, SourceAnchor anchor, List<NamedArgument> arguments) {
    return new Edge(
        EdgeKind.ANNOTATION_USE, from, to, provenance, anchor, null,
        arguments == null ? List.of() : arguments, null, null, null);
  }

  /** Entity → Type: a type usage that is none of the above (casts, generics, annotations). */
  public static Edge reference(String from, String to, Provenance provenance, SourceAnchor anchor) {
    return new Edge(EdgeKind.REFERENCE, from, to, provenance, anchor, null, null, null, null, null);
  }

  /**
   * METAMODEL.md §4: {@code from ≠ to}. Java has legal self-reference (recursion,
   * a class referencing itself), so the extractor DROPS such edges rather than
   * failing — hence a predicate here instead of a constructor check.
   */
  public boolean selfReference() {
    return from.equals(to);
  }

  /**
   * Deterministic order: (edge, from, to, anchor.file, anchor.span[0]). Two runs
   * over the same corpus must produce byte-identical output, so no HashMap or
   * HashSet iteration order may survive into the written model.
   */
  public static final Comparator<Edge> DETERMINISTIC_ORDER =
      Comparator.comparing((Edge e) -> e.edge().json())
          .thenComparing(Edge::from)
          .thenComparing(Edge::to)
          .thenComparing(e -> e.anchor().file())
          .thenComparingInt(e -> e.anchor().startLine())
          .thenComparingInt(e -> e.anchor().endLine())
          .thenComparing(e -> e.provenance().json());

  private static void requireText(String value, String what) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException(what + " must be non-blank");
    }
  }
}
