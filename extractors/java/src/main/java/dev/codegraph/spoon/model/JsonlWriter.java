package dev.codegraph.spoon.model;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamWriteFeature;
import com.fasterxml.jackson.core.JsonGenerator;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.StringWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Serializes a {@link Model} to {@code model.jsonl} — the interchange contract
 * (schemas/README.md). One JSON object per line, written a line at a time:
 * nothing here ever holds the whole document, which is the point of the format.
 * The v1 whole-document writer could not produce Fineract's model at all.
 *
 * <p>Four properties are non-negotiable and all four live here:
 *
 * <ul>
 *   <li><b>No rendered id is written.</b> Identity travels as the natural key —
 *       {@code m} (the owning module's surrogate), {@code s}, {@code d} — and
 *       every reference travels as an entity's surrogate.
 *   <li><b>Canonical order.</b> Entities sort by natural key, and that order IS
 *       the surrogate assignment; edges sort by their endpoints' surrogates.
 *   <li><b>Deterministic bytes.</b> Fixed key order per record, sorted
 *       dictionaries, sorted file table, LF, UTF-8. Two runs over one corpus
 *       produce identical files — and so does the TypeScript encoder, which is
 *       asserted against this writer's output.
 *   <li><b>Absent keys are OMITTED, never null.</b> {@code "name": null}
 *       violates the trait-key rule.
 * </ul>
 */
public final class JsonlWriter {

  /**
   * AUTO_CLOSE_TARGET off: one generator serves the whole file, and closing it
   * must not close the stream under it. The root-value separator is emptied
   * because this writer places the line breaks itself — including the last one.
   */
  private final JsonFactory factory =
      JsonFactory.builder()
          .disable(StreamWriteFeature.AUTO_CLOSE_TARGET)
          .build()
          .setRootValueSeparator("");

  /** Serializes to a UTF-8 string. For tests and small models; large ones stream. */
  public String toJsonl(Model model) {
    StringWriter out = new StringWriter();
    try {
      write(model, out, Observer.NONE);
    } catch (IOException e) {
      throw new IllegalStateException("failed to serialize model", e);
    }
    return out.toString();
  }

  public void write(Model model, Path out) throws IOException {
    write(model, out, Observer.NONE);
  }

  /** Writes while reporting record counts — the caller decides what to do with them. */
  public void write(Model model, Path out, Observer observer) throws IOException {
    Path parent = out.toAbsolutePath().getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
    try (BufferedWriter writer = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
      write(model, writer, observer);
    }
  }

  /**
   * How a caller watches a write. The total is announced late on purpose: the
   * record count is only known once the writer has planned the file (the file
   * table and the surrogates are part of it), and a progress bar must never be
   * given a total the writer had to guess.
   *
   * <p>Declared here rather than taking a {@code Progress} so the model package
   * keeps no dependency on the extractor's CLI concerns.
   */
  public interface Observer {

    Observer NONE =
        new Observer() {
          @Override
          public void total(long records) {}

          @Override
          public void written(long records) {}
        };

    /** The number of records this write will produce. */
    void total(long records);

    /** How many have been written so far. */
    void written(long records);
  }

  public void write(Model model, OutputStream out) throws IOException {
    Writer writer = new BufferedWriter(new java.io.OutputStreamWriter(out, StandardCharsets.UTF_8));
    write(model, writer, Observer.NONE);
    writer.flush();
  }

  // ------------------------------------------------------------------ the encoding

  private void write(Model model, Writer out, Observer observer) throws IOException {
    List<Keyed> entities = canonical(model.entities());
    Surrogates surrogates = Surrogates.of(entities);
    FileTable files = FileTable.of(model.entities(), model.edges());
    Dictionaries dict = Dictionaries.of(model.entities(), model.edges());
    List<Edge> edges = sortedEdges(model.edges(), surrogates, files);

    // header + file table + entities + edges + eof: the file is now planned, so
    // the total is a fact rather than an estimate.
    long total = 2L + files.paths.size() + entities.size() + edges.size();
    observer.total(total);
    long written = 0;

    try (JsonGenerator generator = factory.createGenerator(out)) {
      writeHeader(generator, model, dict);
      observer.written(++written);
      for (int i = 0; i < files.paths.size(); i++) {
        writeFile(generator, i, files.paths.get(i));
        observer.written(++written);
      }
      for (int i = 0; i < entities.size(); i++) {
        writeEntity(generator, i, entities.get(i), surrogates, files, dict);
        observer.written(++written);
      }
      for (Edge edge : edges) {
        writeEdge(generator, edge, surrogates, files, dict);
        observer.written(++written);
      }
      writeEof(generator, files.paths.size(), entities.size(), edges.size());
      observer.written(++written);
    }
  }

  /** An entity with its key decoded once — parsing it per comparison would not scale. */
  private record Keyed(Entity entity, NaturalKey key) {}

  /** Canonical model order (MM-1) — recomputed here so the writer never trusts its input. */
  private static List<Keyed> canonical(List<Entity> entities) {
    List<Keyed> keyed = new ArrayList<>(entities.size());
    for (Entity entity : entities) {
      keyed.add(new Keyed(entity, NaturalKey.parse(entity.id())));
    }
    keyed.sort(Comparator.comparing(Keyed::key));
    return keyed;
  }

  private void writeHeader(JsonGenerator out, Model model, Dictionaries dict) throws IOException {
    line(
        out,
        generator -> {
          generator.writeStringField("t", "header");
          generator.writeStringField("schemaVersion", model.schemaVersion());
          generator.writeStringField("lang", model.lang());
          generator.writeObjectFieldStart("extractor");
          generator.writeStringField("name", model.extractor().name());
          generator.writeStringField("version", model.extractor().version());
          if (model.extractor().noClasspath() != null) {
            generator.writeBooleanField("noClasspath", model.extractor().noClasspath());
          }
          generator.writeEndObject();
          generator.writeStringField("root", model.root());
          Repository repository = model.repository();
          if (repository != null) {
            generator.writeObjectFieldStart("repository");
            generator.writeStringField("remote", repository.remote());
            generator.writeStringField("commit", repository.commit());
            generator.writeStringField("root", repository.root());
            if (repository.provider() != null) {
              generator.writeStringField("provider", repository.provider());
            }
            generator.writeEndObject();
          }
          generator.writeObjectFieldStart("dict");
          strings(generator, "kinds", dict.kinds);
          strings(generator, "traits", dict.traits);
          strings(generator, "edges", dict.edgeKinds);
          strings(generator, "provenance", dict.provenances);
          generator.writeEndObject();
        });
  }

  private void writeFile(JsonGenerator out, int index, String path) throws IOException {
    line(
        out,
        generator -> {
          generator.writeStringField("t", "f");
          generator.writeNumberField("i", index);
          generator.writeStringField("path", path);
        });
  }

  private void writeEntity(
      JsonGenerator out,
      int index,
      Keyed keyed,
      Surrogates surrogates,
      FileTable files,
      Dictionaries dict)
      throws IOException {
    Entity entity = keyed.entity();
    NaturalKey key = keyed.key();
    int module = surrogates.module(key);
    line(
        out,
        generator -> {
          generator.writeStringField("t", "e");
          generator.writeNumberField("i", index);
          generator.writeNumberField("k", dict.kind(entity.kind()));
          generator.writeArrayFieldStart("tr");
          for (TraitName trait : entity.traits()) {
            generator.writeNumber(dict.trait(trait.name()));
          }
          generator.writeEndArray();
          generator.writeNumberField("m", module);
          // A module writes its own path here — it names itself, so nothing else
          // carries the path. Everything else writes its path below the module.
          generator.writeStringField("s", index == module ? key.module() : key.symbol());
          if (key.disambiguator() != null) {
            generator.writeStringField("d", key.disambiguator());
          }

          if (entity.name() != null) {
            generator.writeStringField("name", entity.name());
          }
          if (entity.signature() != null) {
            generator.writeStringField("signature", entity.signature());
          }
          if (entity.declaredType() != null) {
            generator.writeNumberField("declaredType", surrogates.of(entity.declaredType()));
          }
          if (entity.isStub() != null) {
            generator.writeBooleanField("isStub", entity.isStub());
          }
          if (entity.parent() != null) {
            generator.writeNumberField("parent", surrogates.of(entity.parent()));
          }
          if (entity.attachedTo() != null) {
            generator.writeNumberField("attachedTo", surrogates.of(entity.attachedTo()));
          }
          refs(generator, "parameters", entity.parameters(), surrogates);
          refs(generator, "localVariables", entity.localVariables(), surrogates);
          if (entity.definedIn() != null) {
            generator.writeArrayFieldStart("definedIn");
            for (String path : entity.definedIn()) {
              generator.writeNumber(files.of(path));
            }
            generator.writeEndArray();
          }
          if (entity.comments() != null) {
            generator.writeArrayFieldStart("comments");
            for (String comment : entity.comments()) {
              generator.writeString(comment);
            }
            generator.writeEndArray();
          }
          if (entity.anchor() != null) {
            anchor(generator, entity.anchor(), files);
          }
        });
  }

  private void writeEdge(
      JsonGenerator out, Edge edge, Surrogates surrogates, FileTable files, Dictionaries dict)
      throws IOException {
    line(
        out,
        generator -> {
          generator.writeStringField("t", "x");
          generator.writeNumberField("k", dict.edgeKind(edge.edge().json()));
          generator.writeNumberField("f", surrogates.of(edge.from()));
          generator.writeNumberField("o", surrogates.of(edge.to()));
          generator.writeNumberField("p", dict.provenance(edge.provenance().json()));
          if (edge.candidates() != null) {
            generator.writeArrayFieldStart("candidates");
            for (String candidate : edge.candidates()) {
              generator.writeNumber(surrogates.of(candidate));
            }
            generator.writeEndArray();
          }
          if (edge.isRead() != null) {
            generator.writeBooleanField("isRead", edge.isRead());
          }
          if (edge.isWrite() != null) {
            generator.writeBooleanField("isWrite", edge.isWrite());
          }
          if (edge.sourceFile() != null) {
            generator.writeNumberField("sourceFile", files.of(edge.sourceFile()));
          }
          anchor(generator, edge.anchor(), files);
        });
  }

  private void writeEof(JsonGenerator out, int files, int entities, int edges)
      throws IOException {
    line(
        out,
        generator -> {
          generator.writeStringField("t", "eof");
          generator.writeObjectFieldStart("counts");
          generator.writeNumberField("files", files);
          generator.writeNumberField("entities", entities);
          generator.writeNumberField("edges", edges);
          generator.writeEndObject();
        });
  }

  /**
   * Canonical edge order: endpoints first, so an entity's outgoing edges stay
   * together and a change to one entity is a local diff.
   */
  private static List<Edge> sortedEdges(List<Edge> edges, Surrogates surrogates, FileTable files) {
    List<Edge> sorted = new ArrayList<>(edges);
    sorted.sort(
        Comparator.comparingInt((Edge e) -> surrogates.of(e.from()))
            .thenComparingInt(e -> surrogates.of(e.to()))
            .thenComparing(e -> e.edge().json())
            .thenComparingInt(e -> files.of(e.anchor().file()))
            .thenComparingInt(e -> e.anchor().startLine())
            .thenComparingInt(e -> e.anchor().endLine())
            .thenComparing(e -> e.provenance().json()));
    return sorted;
  }

  // ------------------------------------------------------------------- plumbing

  @FunctionalInterface
  private interface Body {
    void write(JsonGenerator generator) throws IOException;
  }

  /** One record, one line — flushed as it goes, so nothing accumulates. */
  private void line(JsonGenerator out, Body body) throws IOException {
    out.writeStartObject();
    body.write(out);
    out.writeEndObject();
    out.writeRaw('\n');
  }

  private static void anchor(JsonGenerator generator, SourceAnchor anchor, FileTable files)
      throws IOException {
    generator.writeArrayFieldStart("anchor");
    generator.writeNumber(files.of(anchor.file()));
    generator.writeNumber(anchor.startLine());
    generator.writeNumber(anchor.endLine());
    generator.writeEndArray();
  }

  private static void refs(
      JsonGenerator generator, String field, List<String> ids, Surrogates surrogates)
      throws IOException {
    if (ids == null) {
      return;
    }
    generator.writeArrayFieldStart(field);
    for (String id : ids) {
      generator.writeNumber(surrogates.of(id));
    }
    generator.writeEndArray();
  }

  private static void strings(JsonGenerator generator, String field, List<String> values)
      throws IOException {
    generator.writeArrayFieldStart(field);
    for (String value : values) {
      generator.writeString(value);
    }
    generator.writeEndArray();
  }

  /** Entity id → surrogate, and module path → the module entity's surrogate. */
  private record Surrogates(Map<String, Integer> byId, Map<String, Integer> byModulePath) {

    static Surrogates of(List<Keyed> canonicalEntities) {
      Map<String, Integer> byId = new HashMap<>(canonicalEntities.size() * 2);
      Map<String, Integer> byModulePath = new HashMap<>();
      for (int i = 0; i < canonicalEntities.size(); i++) {
        Keyed keyed = canonicalEntities.get(i);
        if (byId.putIfAbsent(keyed.entity().id(), i) != null) {
          throw new IllegalStateException("duplicate natural key: " + keyed.entity().id());
        }
        if (keyed.key().isModule()) {
          byModulePath.putIfAbsent(keyed.key().module(), i);
        }
      }
      return new Surrogates(byId, byModulePath);
    }

    int of(String id) {
      Integer surrogate = byId.get(id);
      if (surrogate == null) {
        throw new IllegalStateException("reference to an entity this model does not declare: " + id);
      }
      return surrogate;
    }

    int module(NaturalKey key) {
      Integer surrogate = byModulePath.get(key.module());
      if (surrogate == null) {
        throw new IllegalStateException(
            "entity " + key.render() + " names module \"" + key.module()
                + "\", which declares no module entity");
      }
      return surrogate;
    }
  }

  /** The one unbounded string set — paths — interned once, sorted. */
  private record FileTable(List<String> paths, Map<String, Integer> index) {

    static FileTable of(List<Entity> entities, List<Edge> edges) {
      TreeSet<String> paths = new TreeSet<>();
      for (Entity entity : entities) {
        if (entity.anchor() != null) {
          paths.add(entity.anchor().file());
        }
        if (entity.definedIn() != null) {
          paths.addAll(entity.definedIn());
        }
      }
      for (Edge edge : edges) {
        paths.add(edge.anchor().file());
        if (edge.sourceFile() != null) {
          paths.add(edge.sourceFile());
        }
      }
      List<String> ordered = List.copyOf(paths);
      Map<String, Integer> index = new HashMap<>(ordered.size() * 2);
      for (int i = 0; i < ordered.size(); i++) {
        index.put(ordered.get(i), i);
      }
      return new FileTable(ordered, index);
    }

    int of(String path) {
      Integer at = index.get(path);
      if (at == null) {
        throw new IllegalStateException("unknown path: " + path);
      }
      return at;
    }
  }

  /**
   * The closed vocabularies this model uses (MM-3), sorted. Indices are
   * model-declared, so extending core's vocabulary never renumbers a file.
   */
  private record Dictionaries(
      List<String> kinds,
      List<String> traits,
      List<String> edgeKinds,
      List<String> provenances,
      Map<String, Integer> kindIndex,
      Map<String, Integer> traitIndex,
      Map<String, Integer> edgeKindIndex,
      Map<String, Integer> provenanceIndex) {

    static Dictionaries of(List<Entity> entities, List<Edge> edges) {
      TreeSet<String> kinds = new TreeSet<>();
      TreeSet<String> traits = new TreeSet<>();
      TreeSet<String> edgeKinds = new TreeSet<>();
      TreeSet<String> provenances = new TreeSet<>();
      for (Entity entity : entities) {
        kinds.add(entity.kind());
        for (TraitName trait : entity.traits()) {
          traits.add(trait.name());
        }
      }
      for (Edge edge : edges) {
        edgeKinds.add(edge.edge().json());
        provenances.add(edge.provenance().json());
      }
      return new Dictionaries(
          List.copyOf(kinds),
          List.copyOf(traits),
          List.copyOf(edgeKinds),
          List.copyOf(provenances),
          indexOf(kinds),
          indexOf(traits),
          indexOf(edgeKinds),
          indexOf(provenances));
    }

    private static Map<String, Integer> indexOf(TreeSet<String> values) {
      Map<String, Integer> index = new LinkedHashMap<>();
      int at = 0;
      for (String value : values) {
        index.put(value, at++);
      }
      return index;
    }

    int kind(String value) {
      return require(kindIndex, value, "kind");
    }

    int trait(String value) {
      return require(traitIndex, value, "trait");
    }

    int edgeKind(String value) {
      return require(edgeKindIndex, value, "edge kind");
    }

    int provenance(String value) {
      return require(provenanceIndex, value, "provenance");
    }

    private static int require(Map<String, Integer> index, String value, String what) {
      Integer at = index.get(value);
      if (at == null) {
        throw new IllegalStateException(what + " missing from the header dictionary: " + value);
      }
      return at;
    }
  }
}
