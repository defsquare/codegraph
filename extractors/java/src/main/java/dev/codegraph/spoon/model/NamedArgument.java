package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;

/**
 * One argument of an annotation use (METAMODEL.md §1.6), always named: Java's
 * implicit {@code @Foo("x")} is normalized to {@code value = "x"} here, so a
 * consumer never has to know which language spells the default element how.
 */
@JsonPropertyOrder({"name", "value"})
public record NamedArgument(String name, Literal value) {

  public NamedArgument {
    if (name == null || name.isBlank()) {
      throw new IllegalArgumentException("an annotation argument must be named");
    }
    if (value == null) {
      throw new IllegalArgumentException("an annotation argument must have a value: " + name);
    }
  }
}
