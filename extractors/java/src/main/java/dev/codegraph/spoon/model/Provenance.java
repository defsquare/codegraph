package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * How we know an edge (METAMODEL.md §1.3). Exactly four values; the schema
 * rejects anything else. Facts-only analyses filter on {@link #DECLARED}, so
 * never label an inference {@code declared}.
 */
public enum Provenance {
  /** Written in the source: an {@code implements} clause, a resolved call. */
  DECLARED("declared"),
  /** Inferred by the extractor (structural implementation, promotion…). */
  DERIVED("derived"),
  /** One possible target of an uncertain dispatch; pair with {@code candidates}. */
  DYNAMIC_CANDIDATE("dynamic-candidate"),
  /** Produced by a generator visible to the extractor (Lombok expansions). */
  GENERATED("generated");

  private final String json;

  Provenance(String json) {
    this.json = json;
  }

  /** The wire value — note the hyphen in {@code dynamic-candidate}. */
  @JsonValue
  public String json() {
    return json;
  }
}
