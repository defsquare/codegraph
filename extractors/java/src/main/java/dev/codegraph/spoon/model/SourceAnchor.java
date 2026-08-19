package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.List;

/**
 * Evidence: where a fact was observed (METAMODEL.md §1.2). {@code file} is
 * relative to the model's {@code root}; the span is {@code [startLine, endLine]}
 * and is <b>1-based</b> — the schema rejects a 0.
 *
 * <p>Spoon returns invalid positions for synthetic and implicit elements, so
 * {@code getPosition().isValidPosition()} must be checked before constructing
 * one; {@code dev.codegraph.spoon.Anchors} does that and walks to the enclosing
 * element when it fails, because an anchor is required on every edge.
 */
@JsonPropertyOrder({"file", "span"})
public record SourceAnchor(String file, List<Integer> span) {

  public SourceAnchor {
    if (file == null || file.isBlank()) {
      throw new IllegalArgumentException("anchor file must be non-blank");
    }
    if (span == null || span.size() != 2) {
      throw new IllegalArgumentException("anchor span must be [startLine, endLine]");
    }
    span = List.copyOf(span);
  }

  /** Lines are 1-based; a 0 means "no position" and must never reach the model. */
  public static SourceAnchor of(String file, int startLine, int endLine) {
    if (startLine < 1 || endLine < 1) {
      throw new IllegalArgumentException(
          "anchor spans are 1-based, got [" + startLine + ", " + endLine + "] for " + file);
    }
    return new SourceAnchor(file, List.of(startLine, Math.max(startLine, endLine)));
  }

  public int startLine() {
    return span.get(0);
  }

  public int endLine() {
    return span.get(1);
  }
}
