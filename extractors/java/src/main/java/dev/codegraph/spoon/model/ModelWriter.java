package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Serializes a {@link Model} to model.json.
 *
 * <p>Three properties are non-negotiable and all three live here:
 * <ul>
 *   <li>absent keys are OMITTED, never {@code null} — {@code "name": null}
 *       violates the trait-key rule the schema enforces;
 *   <li>the byte stream is deterministic: fixed field order (per-record
 *       {@code @JsonPropertyOrder}), fixed LF indentation (Jackson's default
 *       pretty printer uses the platform line separator, which would make
 *       output differ between machines), UTF-8, one trailing newline;
 *   <li>nothing is written that the caller did not sort — see {@link Model#sorted}.
 * </ul>
 */
public final class ModelWriter {

  private final ObjectWriter writer;

  public ModelWriter(boolean pretty) {
    ObjectMapper mapper = new ObjectMapper();
    mapper.setSerializationInclusion(JsonInclude.Include.NON_NULL);
    if (pretty) {
      DefaultPrettyPrinter printer = new DefaultPrettyPrinter();
      DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
      printer.indentObjectsWith(indenter);
      printer.indentArraysWith(indenter);
      this.writer = mapper.writer(printer);
    } else {
      this.writer = mapper.writer();
    }
  }

  /** Serializes to a UTF-8 string terminated by exactly one newline. */
  public String toJson(Model model) {
    try {
      return writer.writeValueAsString(model) + "\n";
    } catch (IOException e) {
      throw new IllegalStateException("failed to serialize model", e);
    }
  }

  public void write(Model model, Path out) throws IOException {
    Path parent = out.toAbsolutePath().getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
    Files.writeString(out, toJson(model), StandardCharsets.UTF_8);
  }

  public void write(Model model, OutputStream out) throws IOException {
    out.write(toJson(model).getBytes(StandardCharsets.UTF_8));
    out.flush();
  }
}
