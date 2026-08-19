package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * The nine edge kinds of the contract (METAMODEL.md §4). The Java profile
 * licenses only six of them — {@link #EMBEDDING} (Go), {@link #TRAIT_USAGE}
 * (PHP) and {@link #FILE_INCLUDE} (PHP) exist here because this enum mirrors
 * the interchange format, not because this extractor may emit them. There is
 * deliberately no {@link Edge} factory for those three.
 */
public enum EdgeKind {
  IMPORT("import"),
  INHERITANCE("inheritance"),
  INTERFACE_IMPLEMENTATION("interfaceImplementation"),
  INVOCATION("invocation"),
  ACCESS("access"),
  REFERENCE("reference"),
  EMBEDDING("embedding"),
  TRAIT_USAGE("traitUsage"),
  FILE_INCLUDE("fileInclude");

  private final String json;

  EdgeKind(String json) {
    this.json = json;
  }

  @JsonValue
  public String json() {
    return json;
  }
}
