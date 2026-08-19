package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;

/**
 * Provenance of the model itself (METAMODEL.md §8). The schema allows extra
 * extractor-specific flags; {@code noClasspath} is the one that matters for
 * reading a Java model honestly — it says the FQNs may be Spoon's inventions.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"name", "version", "noClasspath"})
public record ExtractorInfo(String name, String version, @JsonProperty("noClasspath") Boolean noClasspath) {

  public ExtractorInfo {
    if (name == null || name.isBlank()) {
      throw new IllegalArgumentException("extractor name must be non-blank");
    }
    if (version == null || version.isBlank()) {
      throw new IllegalArgumentException("extractor version must be non-blank");
    }
  }
}
