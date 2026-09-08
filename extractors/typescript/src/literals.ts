import ts from "typescript";
import { Ids, unwrap } from "./ids.js";
import type { Literal, NamedArgument } from "./model/model.js";

/**
 * The value door (METAMODEL.md §1.6): a written, declaration-site value.
 * TypeScript folds nothing at the declaration (`4 * 25` stays an expression),
 * so what is emitted is exactly what is written: literals, `-N`, an enum
 * member, a type used as a value, arrays of those — and everything else as
 * `unevaluated`, its source text kept and labelled. Nothing is run.
 */
export function literalOf(expression: ts.Expression, ids: Ids): Literal {
  return literalOrUnevaluated(expression, ids);
}

/**
 * A declaration-site value, or undefined when the initializer is CODE — a
 * call, a `new`, a function, an object literal — which carries no value at
 * all (absence is a claim, the C# rule). A constant-shaped expression the
 * extractor does not fold (`4 * 25`) rides as `unevaluated`.
 */
export function valueOf(expression: ts.Expression, ids: Ids): Literal | undefined {
  return isConstantShaped(unwrap(expression) ?? expression) ? literalOrUnevaluated(expression, ids) : undefined;
}

function isConstantShaped(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return isConstantShaped(node.operand);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return isConstantShaped(node.expression);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
    return isConstantShaped(node.left) && isConstantShaped(node.right);
  }
  if (ts.isConditionalExpression(node)) return isConstantShaped(node.condition) && isConstantShaped(node.whenTrue) && isConstantShaped(node.whenFalse);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isConstantShaped(span.expression));
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => !ts.isSpreadElement(element) && isConstantShaped(element));
  return false;
}

function literalOrUnevaluated(expression: ts.Expression, ids: Ids): Literal {
  const node = unwrap(expression) ?? expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { k: "string", v: node.text };
  if (ts.isNumericLiteral(node)) return { k: "number", v: canonicalNumber(node.text) };
  if (ts.isBigIntLiteral(node)) return { k: "number", v: node.text.replace(/n$/, "") };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const text = canonicalNumber(node.operand.text);
    return { k: "number", v: text === "0" ? "0" : `-${text}` };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: "boolean", v: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: "boolean", v: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { k: "null" };
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((element) => (ts.isSpreadElement(element) ? undefined : literalOrUnevaluated(element, ids)));
    if (items.every((item) => item !== undefined)) return { k: "array", items: items as Literal[] };
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const symbol = ids.checker.getSymbolAtLocation(node);
    const resolved = symbol === undefined ? undefined : ids.resolveAlias(symbol);
    if (resolved !== undefined) {
      if (resolved.flags & ts.SymbolFlags.EnumMember) {
        const member = ids.primaryDeclaration(resolved);
        const enumSymbol = member?.parent !== undefined && ts.isEnumDeclaration(member.parent) ? ids.checker.getSymbolAtLocation(member.parent.name) : undefined;
        const type = enumSymbol === undefined ? undefined : ids.typeKeyOfSymbol(enumSymbol);
        if (type !== undefined) return { k: "enum", type, name: resolved.name };
      }
      if (resolved.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) {
        const type = ids.typeKeyOfSymbol(resolved);
        if (type !== undefined) return { k: "type", type };
      }
    }
  }
  return { k: "unevaluated", source: node.getText().replace(/\s+/g, " ").trim() || "?" };
}

/** `0x10`, `1_000`, `1e3`, `.5` → JavaScript's canonical decimal text. */
export function canonicalNumber(text: string): string {
  const value = Number(text.replaceAll("_", ""));
  return Number.isFinite(value) ? String(value) : text;
}

/**
 * A decorator's arguments, named after the factory's parameters when the
 * callee resolves to a function, `arg<i>` otherwise — an implicit name is
 * normalised explicit (METAMODEL.md §1.6).
 */
export function decoratorArguments(call: ts.CallExpression, ids: Ids): NamedArgument[] {
  const signature = ids.checker.getResolvedSignature(call);
  const parameters = signature?.getParameters() ?? [];
  return call.arguments.map((argument, index) => ({
    name: parameters[index]?.name ?? `arg${index}`,
    value: literalOf(argument, ids),
  }));
}
