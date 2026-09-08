import ts from "typescript";
import { isInvocable } from "./ids.js";

/**
 * Measures (TMetrics, METAMODEL.md §3.8), the Java and C# extractors' two,
 * computed on syntax so they are immune to the resolution ceiling:
 *
 * - `sloc` — lines of the node's own span holding at least one token:
 *   neither blank nor comment-only. Comments are trivia and JSDoc nodes are
 *   skipped, so a line with only a comment does not count; a template
 *   literal, regular expression or JSX text token counts every line it spans.
 * - `cyclomatic` — 1 + if / for / for-in / for-of / while / do / non-default
 *   case / catch / ternary / `&&` / `||` / `??` (their assignment forms too).
 *   A nested arrow, function expression, method or class is its own invocable
 *   and does NOT contribute to its enclosing one.
 */
export function sloc(node: ts.Node, file: ts.SourceFile): number {
  const lines = new Set<number>();
  const visit = (current: ts.Node): void => {
    if (current.kind >= ts.SyntaxKind.FirstJSDocNode && current.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (current.kind < ts.SyntaxKind.FirstNode) {
      // A token: mark every line it spans.
      const start = current.getStart(file);
      const end = current.getEnd();
      if (end <= start) return;
      const first = file.getLineAndCharacterOfPosition(start).line;
      const last = file.getLineAndCharacterOfPosition(end - 1).line;
      for (let line = first; line <= last; line += 1) lines.add(line);
      return;
    }
    for (const child of current.getChildren(file)) visit(child);
  };
  visit(node);
  return lines.size;
}

export function cyclomatic(body: ts.Node): number {
  let count = 1;
  const visit = (node: ts.Node, root: boolean): void => {
    if (!root && (isInvocable(node) || ts.isClassLike(node))) return;
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        count += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const operator = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          operator === ts.SyntaxKind.BarBarEqualsToken ||
          operator === ts.SyntaxKind.QuestionQuestionEqualsToken
        ) {
          count += 1;
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, (child) => visit(child, false));
  };
  visit(body, true);
  return count;
}
