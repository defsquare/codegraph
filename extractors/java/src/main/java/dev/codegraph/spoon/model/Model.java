package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Comparator;
import java.util.List;

/**
 * The interchange file (METAMODEL.md §8): one JSON document per extraction run.
 * Conforms to schemas/model.schema.json, which is the whole contract — this
 * extractor holds no metamodel intelligence beyond emitting a conforming shape.
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
   * Assembles a model in the one order that makes output byte-identical across
   * runs: entities by id, edges by {@link Edge#DETERMINISTIC_ORDER}.
   */
  public static Model sorted(ExtractorInfo extractor, String root, List<Entity> entities, List<Edge> edges) {
    List<Entity> sortedEntities = entities.stream().sorted(Comparator.comparing(Entity::id)).toList();
    List<Edge> sortedEdges = edges.stream().sorted(Edge.DETERMINISTIC_ORDER).toList();
    return new Model(SCHEMA_VERSION, LANG, extractor, root, sortedEntities, sortedEdges);
  }
}
