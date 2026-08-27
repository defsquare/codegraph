package dev.codegraph.spoon;

import dev.codegraph.spoon.model.Literal;
import dev.codegraph.spoon.model.NamedArgument;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.eval.PartialEvaluator;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.support.reflect.eval.VisitorPartialEvaluator;

/**
 * Spoon expressions → {@link Literal} (METAMODEL.md §1.6). THE VALUE DOOR, and
 * the discipline that keeps it honest:
 *
 * <ul>
 *   <li><b>Only what the language fixes at the declaration.</b> A literal, or an
 *       expression Spoon's partial evaluator folds from constants. An
 *       initializer that is not a compile-time constant produces NOTHING —
 *       absence means "not constant", which is a different claim from an empty
 *       value.
 *   <li><b>What was written but did not fold is kept, labeled.</b> An
 *       annotation argument naming a constant noClasspath cannot resolve rides
 *       as {@code unevaluated} with its source text. Dropping it would erase a
 *       written fact; pretending to know it would invent one.
 *   <li><b>A value never replaces a dependency.</b> {@code Foo.class} produces a
 *       `type` value AND leaves the written type reference to the edge pass,
 *       which emits its own `reference` edge.
 * </ul>
 */
final class Literals {

  private final PartialEvaluator evaluator = new VisitorPartialEvaluator();

  /**
   * An annotation's arguments, in WRITTEN order, every name explicit — Java's
   * implicit {@code @Foo("x")} is normalized to {@code value = "x"}, which
   * Spoon already does when it keys the value map.
   */
  List<NamedArgument> argumentsOf(CtAnnotation<?> annotation) {
    Map<String, CtExpression> values = new LinkedHashMap<>(annotation.getValues());
    List<NamedArgument> out = new ArrayList<>(values.size());
    for (Map.Entry<String, CtExpression> entry : values.entrySet()) {
      Literal value = of(entry.getValue());
      if (value != null) {
        out.add(new NamedArgument(entry.getKey(), value));
      }
    }
    return List.copyOf(out);
  }

  /**
   * The value of a {@code static final} field — a JLS compile-time constant
   * only. A non-final field, or one whose initializer does not fold, has no
   * declaration-site value at all.
   */
  Optional<Literal> constantOf(CtField<?> field) {
    if (!field.hasModifier(ModifierKind.FINAL) || field.getDefaultExpression() == null) {
      return Optional.empty();
    }
    Literal value = fold(field.getDefaultExpression());
    // An UNEVALUATED field initializer is not a constant — it is ordinary code
    // that happens to be final (`new ArrayList<>()`), and claiming a value for
    // it would be the one thing this class exists to prevent.
    return value == null || value instanceof Literal.Unevaluated ? Optional.empty() : Optional.of(value);
  }

  /** An annotation element's {@code default} — written, so kept even unfolded. */
  Optional<Literal> defaultOf(CtExpression<?> expression) {
    return Optional.ofNullable(expression == null ? null : of(expression));
  }

  /**
   * One expression as a value: folded when it folds, kept as source text when
   * it does not. Null only when there is nothing written to speak of.
   */
  Literal of(CtExpression<?> expression) {
    if (expression == null) {
      return null;
    }
    Literal folded = fold(expression);
    return folded != null ? folded : unevaluated(expression);
  }

  /** The folding half: returns null when the expression is not a constant form. */
  private Literal fold(CtExpression<?> expression) {
    if (expression instanceof CtNewArray<?> array) {
      List<Literal> items = new ArrayList<>();
      for (CtExpression<?> element : array.getElements()) {
        Literal item = of(element);
        if (item == null) {
          return null;
        }
        items.add(item);
      }
      return new Literal.Arr(items);
    }
    if (expression instanceof CtAnnotation<?> nested) {
      String type = EntityIds.forTypeReference(nested.getAnnotationType());
      return new Literal.Annotation(type, argumentsOf(nested));
    }
    // An enum constant is a field read on an enum type: the TYPE is referenced
    // and the constant is NAMED — a member entity is never fabricated (§6).
    if (expression instanceof CtFieldRead<?> read) {
      Literal enumValue = enumValueOf(read);
      if (enumValue != null) {
        return enumValue;
      }
    }
    CtExpression<?> evaluated = evaluate(expression);
    if (evaluated instanceof CtLiteral<?> literal) {
      return ofLiteral(literal);
    }
    return null;
  }

  private CtExpression<?> evaluate(CtExpression<?> expression) {
    if (expression instanceof CtLiteral<?>) {
      return expression;
    }
    try {
      return evaluator.evaluate(expression);
    } catch (RuntimeException notFoldable) {
      // The evaluator throws on anything it cannot reduce (an unresolved field
      // in noClasspath, a method call): that is a "no", not a failure.
      return null;
    }
  }

  private Literal ofLiteral(CtLiteral<?> literal) {
    Object value = literal.getValue();
    if (value == null) {
      return new Literal.Null();
    }
    if (value instanceof Boolean bool) {
      return new Literal.Bool(bool);
    }
    // A char rides as a one-character string; the declared type is what keeps
    // 'a' and "a" apart, and inventing a `char` tag would not help a consumer.
    if (value instanceof Character character) {
      return new Literal.Str(String.valueOf(character));
    }
    if (value instanceof CharSequence text) {
      return new Literal.Str(text.toString());
    }
    if (value instanceof Number number) {
      return new Literal.Num(canonical(number));
    }
    if (value instanceof CtTypeReference<?> type) {
      return new Literal.TypeValue(EntityIds.forTypeReference(type));
    }
    return null;
  }

  /**
   * Canonical decimal text. Integral types print exactly; a float or double
   * goes through {@link BigDecimal} so `1.0E10` and friends come out in the one
   * form core's schema accepts, with NaN and the infinities named.
   */
  private static String canonical(Number number) {
    if (number instanceof Integer || number instanceof Long
        || number instanceof Short || number instanceof Byte) {
      return number.toString();
    }
    double value = number.doubleValue();
    if (Double.isNaN(value)) {
      return "NaN";
    }
    if (Double.isInfinite(value)) {
      return value > 0 ? "Infinity" : "-Infinity";
    }
    return new BigDecimal(number.toString()).stripTrailingZeros().toPlainString();
  }

  /** `RetentionPolicy.RUNTIME` → the enum type plus the constant's name. */
  private static Literal enumValueOf(CtFieldRead<?> read) {
    CtFieldReference<?> field = read.getVariable();
    if (field == null || field.getDeclaringType() == null) {
      return null;
    }
    CtTypeReference<?> owner = field.getDeclaringType();
    boolean isEnumConstant =
        owner.isEnum()
            || (field.getFieldDeclaration() != null
                && field.getFieldDeclaration().getParent() instanceof spoon.reflect.declaration.CtEnum<?>);
    if (!isEnumConstant) {
      return null;
    }
    String name = field.getSimpleName();
    return name == null || name.isBlank()
        ? null
        : new Literal.EnumValue(EntityIds.forTypeReference(owner), name);
  }

  /** The written text, trimmed of nothing: what the source says, verbatim. */
  private static Literal unevaluated(CtElement expression) {
    String source = sourceOf(expression);
    return source.isBlank() ? null : new Literal.Unevaluated(source);
  }

  private static String sourceOf(CtElement element) {
    try {
      if (element.getPosition() != null && element.getPosition().isValidPosition()) {
        String text = element.getPosition().getCompilationUnit().getOriginalSourceCode();
        int start = element.getPosition().getSourceStart();
        int end = element.getPosition().getSourceEnd();
        if (text != null && start >= 0 && end >= start && end < text.length()) {
          return text.substring(start, end + 1);
        }
      }
      return element.toString();
    } catch (RuntimeException unprintable) {
      return "";
    }
  }
}
