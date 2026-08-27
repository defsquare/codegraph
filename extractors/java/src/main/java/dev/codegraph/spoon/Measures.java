package dev.codegraph.spoon;

import dev.codegraph.spoon.model.SourceAnchor;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.OptionalInt;
import spoon.reflect.code.BinaryOperatorKind;
import spoon.reflect.code.CtBinaryOperator;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtConditional;
import spoon.reflect.code.CtDo;
import spoon.reflect.code.CtFor;
import spoon.reflect.code.CtForEach;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtNewClass;
import spoon.reflect.code.CtWhile;
import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtType;
import spoon.reflect.visitor.CtScanner;

/**
 * The measures the model carries (METAMODEL.md §3.8): {@code sloc} for anything
 * with a span, {@code cyclomatic} for anything invocable.
 *
 * <p><b>Only the extractor measures.</b> Both numbers require reading source no
 * consumer sees — {@code sloc} needs to know which lines are comments, and
 * complexity needs the syntax tree. Gross span length stays a DERIVED proxy
 * downstream, and the two claims are never conflated.
 *
 * <p>Both are PURELY SYNTACTIC, which is what makes them trustworthy here: they
 * do not depend on a single type resolving, so noClasspath's resolution ceiling
 * cannot bend them the way it bends the edge graph.
 */
final class Measures {

  static final String SLOC = "sloc";
  static final String CYCLOMATIC = "cyclomatic";

  /** Per compilation unit: is line N code? Index 0 unused, lines are 1-based. */
  private final Map<CompilationUnit, boolean[]> codeLines = new IdentityHashMap<>();

  /**
   * Lines of {@code anchor}'s span that are neither blank nor comment-only. The
   * anchor is passed in rather than recomputed so the measure is over exactly
   * the span the entity publishes — which is what makes {@code sloc <= span}
   * true by construction rather than by luck.
   */
  OptionalInt sloc(CtElement element, SourceAnchor anchor) {
    boolean[] code = codeLinesOf(element);
    if (code == null) {
      return OptionalInt.empty();
    }
    int start = Math.max(1, anchor.startLine());
    int end = Math.min(anchor.endLine(), code.length - 1);
    int count = 0;
    for (int line = start; line <= end; line++) {
      if (code[line]) {
        count++;
      }
    }
    return OptionalInt.of(count);
  }

  /**
   * 1 + the decision points written INSIDE this executable: {@code if}, the four
   * loops, each non-default case label, {@code catch}, {@code ?:}, short-circuit
   * {@code &&} / {@code ||}, and a switch pattern guard.
   *
   * <p>A nested lambda, anonymous class or local class contributes NOTHING here:
   * each is its own invocable entity and carries its own count. Otherwise one
   * method would be charged twice for the same branch — once itself, once
   * through the lambda it happens to contain.
   */
  int cyclomatic(CtExecutable<?> executable) {
    Complexity complexity = new Complexity();
    // Scan the BODY, not the executable: scanning the executable would visit
    // itself and, for a lambda, stop immediately at the skip rule below.
    if (executable.getBody() != null) {
      complexity.scan(executable.getBody());
    } else if (executable instanceof CtLambda<?> lambda && lambda.getExpression() != null) {
      // An expression lambda (`x -> a && b`) has no block body but does branch.
      complexity.scan(lambda.getExpression());
    }
    return complexity.count;
  }

  /** Both measures for an invocable, in canonical (sorted) key order. */
  Map<String, Number> of(CtExecutable<?> executable, SourceAnchor anchor) {
    Map<String, Number> metrics = new LinkedHashMap<>();
    metrics.put(CYCLOMATIC, cyclomatic(executable));
    sloc(executable, anchor).ifPresent(lines -> metrics.put(SLOC, lines));
    return metrics;
  }

  /** {@code sloc} alone — for a type, whose complexity is its members' sum. */
  Map<String, Number> of(CtType<?> type, SourceAnchor anchor) {
    Map<String, Number> metrics = new LinkedHashMap<>();
    sloc(type, anchor).ifPresent(lines -> metrics.put(SLOC, lines));
    return metrics;
  }

  private boolean[] codeLinesOf(CtElement element) {
    SourcePosition position = element.getPosition();
    if (position == null || !position.isValidPosition()) {
      return null;
    }
    CompilationUnit unit = position.getCompilationUnit();
    if (unit == null) {
      return null;
    }
    return codeLines.computeIfAbsent(unit, cu -> classify(cu.getOriginalSourceCode()));
  }

  // ─────────────────────────────────────────────────────────── the line scan

  /**
   * Which lines hold code. A small lexer rather than a regex because the naive
   * version is WRONG in a way that silently corrupts every following line: a
   * {@code "/*"} inside a string literal would open a block comment that never
   * closes, and every line after it in the file would count as a comment.
   * String, char and text-block literals are therefore tracked, escapes
   * included.
   */
  private static boolean[] classify(String source) {
    if (source == null) {
      return null;
    }
    int lines = 1;
    for (int i = 0; i < source.length(); i++) {
      if (source.charAt(i) == '\n') {
        lines++;
      }
    }
    boolean[] code = new boolean[lines + 1];

    int line = 1;
    State state = State.NORMAL;
    for (int i = 0; i < source.length(); i++) {
      char c = source.charAt(i);
      if (c == '\n') {
        line++;
        // A line comment ends at the newline; a block comment or text block does not.
        if (state == State.LINE_COMMENT) {
          state = State.NORMAL;
        }
        continue;
      }
      char next = i + 1 < source.length() ? source.charAt(i + 1) : '\0';

      switch (state) {
        case NORMAL -> {
          if (c == '/' && next == '/') {
            state = State.LINE_COMMENT;
            i++;
          } else if (c == '/' && next == '*') {
            state = State.BLOCK_COMMENT;
            i++;
          } else if (c == '"' && next == '"' && i + 2 < source.length() && source.charAt(i + 2) == '"') {
            code[line] = true;
            state = State.TEXT_BLOCK;
            i += 2;
          } else if (c == '"') {
            code[line] = true;
            state = State.STRING;
          } else if (c == '\'') {
            code[line] = true;
            state = State.CHAR;
          } else if (!Character.isWhitespace(c)) {
            code[line] = true;
          }
        }
        case LINE_COMMENT -> {
          // Nothing but the newline above ends it.
        }
        case BLOCK_COMMENT -> {
          if (c == '*' && next == '/') {
            state = State.NORMAL;
            i++;
          }
        }
        case STRING, CHAR -> {
          code[line] = true;
          if (c == '\\') {
            i++; // the escaped character cannot end the literal
          } else if ((state == State.STRING && c == '"') || (state == State.CHAR && c == '\'')) {
            state = State.NORMAL;
          }
        }
        case TEXT_BLOCK -> {
          if (!Character.isWhitespace(c)) {
            code[line] = true;
          }
          if (c == '\\') {
            i++;
          } else if (c == '"' && next == '"' && i + 2 < source.length() && source.charAt(i + 2) == '"') {
            state = State.NORMAL;
            i += 2;
          }
        }
      }
    }
    return code;
  }

  private enum State {
    NORMAL,
    LINE_COMMENT,
    BLOCK_COMMENT,
    STRING,
    CHAR,
    TEXT_BLOCK
  }

  // ───────────────────────────────────────────────────────── the branch scan

  /** Counts decision points, stopping at anything that is its own invocable. */
  private static final class Complexity extends CtScanner {

    private int count = 1;

    @Override
    public <T> void visitCtLambda(CtLambda<T> lambda) {
      // Its own invocable: its branches are its own (METAMODEL §3.8).
    }

    @Override
    public <T> void visitCtNewClass(CtNewClass<T> newClass) {
      // The arguments are written here and may branch (`new X(a ? b : c)`); the
      // anonymous body is a separate entity, so it is not scanned.
      scan(newClass.getTarget());
      scan(newClass.getArguments());
    }

    @Override
    public <T> void visitCtClass(spoon.reflect.declaration.CtClass<T> declaringClass) {
      // A local class declared in a body: its methods are their own entities.
    }

    @Override
    public <T> void visitCtInterface(spoon.reflect.declaration.CtInterface<T> declaringInterface) {
      // As above — a local interface declares no branch of its enclosing method.
    }

    @Override
    public void visitCtIf(CtIf ifElement) {
      count++;
      super.visitCtIf(ifElement);
    }

    @Override
    public void visitCtFor(CtFor forLoop) {
      count++;
      super.visitCtFor(forLoop);
    }

    @Override
    public void visitCtForEach(CtForEach foreach) {
      count++;
      super.visitCtForEach(foreach);
    }

    @Override
    public void visitCtWhile(CtWhile whileLoop) {
      count++;
      super.visitCtWhile(whileLoop);
    }

    @Override
    public void visitCtDo(CtDo doLoop) {
      count++;
      super.visitCtDo(doLoop);
    }

    @Override
    public <S> void visitCtCase(CtCase<S> caseStatement) {
      // One per case EXPRESSION: `case A, B ->` is two ways in, `default:` none.
      count += caseStatement.getCaseExpressions().size();
      // `case Circle c when c.radius() > 10` — the guard is a decision of its own.
      if (caseStatement.getGuard() != null) {
        count++;
      }
      super.visitCtCase(caseStatement);
    }

    @Override
    public void visitCtCatch(CtCatch catchBlock) {
      count++;
      super.visitCtCatch(catchBlock);
    }

    @Override
    public <T> void visitCtConditional(CtConditional<T> conditional) {
      count++;
      super.visitCtConditional(conditional);
    }

    @Override
    public <T> void visitCtBinaryOperator(CtBinaryOperator<T> operator) {
      BinaryOperatorKind kind = operator.getKind();
      // Short-circuit only: `&` and `|` evaluate both sides — no second path.
      if (kind == BinaryOperatorKind.AND || kind == BinaryOperatorKind.OR) {
        count++;
      }
      super.visitCtBinaryOperator(operator);
    }
  }
}
