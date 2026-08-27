package dev.codegraph.spoon.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.List;

/**
 * A written, declaration-site value (METAMODEL.md §1.6): what an annotation
 * argument, a constant initializer or a default carries in the SOURCE.
 *
 * <p><b>A Literal is what is written, never runtime state.</b> It is emitted
 * only when the language fixes the value at the declaration — a literal, or an
 * expression that folds from constants (JLS §15.29 compile-time constant
 * expressions). Anything else rides as {@link Unevaluated}, which keeps the
 * source text and is honest about what it is — the stub discipline (§6),
 * applied to values — or is not emitted at all.
 *
 * <p>Ids inside a value count for closure exactly like an edge endpoint, and
 * the writer turns them into surrogates, so a value that points at something
 * this model does not declare cannot be written.
 *
 * <p>The tag set is closed and core-owned: an extractor meeting a value it
 * cannot express uses {@code unevaluated}, it does not invent a tag.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public sealed interface Literal {

  /** The tag written as `k` — the discriminator the reader switches on. */
  String k();

  /** Every entity id this value points at, in written order (for the writer). */
  default List<String> references() {
    return List.of();
  }

  /** Chars ride as one-character strings; the declared type keeps 'a' and "a" apart. */
  @JsonPropertyOrder({"k", "v"})
  record Str(String v) implements Literal {
    @Override
    public String k() {
      return "string";
    }
  }

  /**
   * The constant's canonical decimal TEXT. A JSON number is a double, so a Java
   * {@code long} would silently change value on the wire —
   * {@code 9223372036854775807} parses back as {@code 9223372036854776000}.
   */
  @JsonPropertyOrder({"k", "v"})
  record Num(String v) implements Literal {
    @Override
    public String k() {
      return "number";
    }
  }

  @JsonPropertyOrder({"k", "v"})
  record Bool(boolean v) implements Literal {
    @Override
    public String k() {
      return "boolean";
    }
  }

  @JsonPropertyOrder({"k"})
  record Null() implements Literal {
    @Override
    public String k() {
      return "null";
    }
  }

  /**
   * A reference to the enum TYPE plus the constant's simple name. The member is
   * never fabricated as an entity to close the value — §6, verbatim.
   */
  @JsonPropertyOrder({"k", "type", "name"})
  record EnumValue(String type, String name) implements Literal {
    @Override
    public String k() {
      return "enum";
    }

    @Override
    public List<String> references() {
      return List.of(type);
    }
  }

  /** {@code Foo.class}. The written type use still emits its own reference edge. */
  @JsonPropertyOrder({"k", "type"})
  record TypeValue(String type) implements Literal {
    @Override
    public String k() {
      return "type";
    }

    @Override
    public List<String> references() {
      return List.of(type);
    }
  }

  /** Written order kept — a source fact, like parameter order. */
  @JsonPropertyOrder({"k", "items"})
  record Arr(List<Literal> items) implements Literal {
    public Arr {
      items = List.copyOf(items);
    }

    @Override
    public String k() {
      return "array";
    }

    @Override
    public List<String> references() {
      return items.stream().flatMap(item -> item.references().stream()).toList();
    }
  }

  /** A nested annotation value: `@Outer(@Inner("x"))`. */
  @JsonPropertyOrder({"k", "type", "arguments"})
  record Annotation(String type, List<NamedArgument> arguments) implements Literal {
    public Annotation {
      arguments = List.copyOf(arguments);
    }

    @Override
    public String k() {
      return "annotation";
    }

    @Override
    public List<String> references() {
      List<String> out = new java.util.ArrayList<>();
      out.add(type);
      for (NamedArgument argument : arguments) {
        out.addAll(argument.value().references());
      }
      return List.copyOf(out);
    }
  }

  /**
   * A written constant expression this extractor did not fold — an unresolvable
   * constant in noClasspath, most often. The source text is still a fact, so it
   * is kept and labeled rather than dropped.
   */
  @JsonPropertyOrder({"k", "source"})
  record Unevaluated(String source) implements Literal {
    @Override
    public String k() {
      return "unevaluated";
    }
  }
}
