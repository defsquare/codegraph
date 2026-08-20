package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Comparator;
import java.util.List;

/**
 * One extraction run (METAMODEL.md §8a). Conforms to schemas/ — the per-record
 * JSON Schemas plus the container contract are the whole of it; this extractor
 * holds no metamodel intelligence beyond emitting a conforming file.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"schemaVersion", "lang", "extractor", "root", "entities", "edges"})
public record Model(
    String schemaVersion,
    String lang,
    ExtractorInfo extractor,
    String root,
    List<Entity> entities,
    List<Edge> edges) {

  /** Version of the interchange contract (mirrors SCHEMA_VERSION in @codegraph/core). */
  public static final String SCHEMA_VERSION = "1.0.0";

  /** Profile id — frozen (PLAN.md §4.4): it is the prefix of every id emitted. */
  public static final String LANG = "java";

  public Model {
    entities = List.copyOf(entities);
    edges = List.copyOf(edges);
  }

  /**
   * Assembles a model in canonical order (MM-1): entities by natural key, which
   * is what {@link JsonlWriter} turns into surrogates. Edges are sorted by their
   * endpoints' surrogates, so their final order is the writer's to impose —
   * {@link Edge#DETERMINISTIC_ORDER} here only keeps the in-memory model stable
   * for anything that inspects it before writing.
   */
  public static Model sorted(ExtractorInfo extractor, String root, List<Entity> entities, List<Edge> edges) {
    List<Entity> sortedEntities =
        entities.stream()
            .sorted(Comparator.comparing(entity -> NaturalKey.parse(entity.id())))
            .toList();
    List<Edge> sortedEdges = edges.stream().sorted(Edge.DETERMINISTIC_ORDER).toList();
    return new Model(SCHEMA_VERSION, LANG, extractor, root, sortedEntities, sortedEdges);
  }
}
