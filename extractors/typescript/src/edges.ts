import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { Corpus } from "./corpus.js";
import type { EntityTable } from "./entities.js";
import { boundName, Ids, isInvocable, isKeyedDeclaration, isLocalOrParameter, isTypeDeclaration } from "./ids.js";
import { decoratorArguments } from "./literals.js";
import { escapePath, keysEqual, type Key } from "./model/keys.js";
import type { Anchor, Edge, EdgeKind } from "./model/model.js";
import { slashes } from "./paths.js";
import type { ResolutionStats } from "./stats.js";
import type { Stubs } from "./stubs.js";

/**
 * Pass 3 — edges, every one `declared` and anchored at the site that wrote
 * it: imports (module → module), heritage, invocations (calls, `new`, tagged
 * templates, JSX elements), accesses (reads and writes of properties and
 * module-level variables), references (written type uses), decorators as
 * `annotationUse`, and throw sites. The FROM of an edge is its narrowest
 * declared owner: the invocable, else the property or variable whose
 * initializer wrote it, else the type or module — locals never own edges.
 */
export function extractEdges(corpus: Corpus, ids: Ids, stubs: Stubs, table: EntityTable, stats: ResolutionStats): Edge[] {
  const edges: Edge[] = [];
  for (const file of corpus.files) {
    const source = corpus.program.getSourceFile(file);
    if (source === undefined) continue;
    new EdgeVisitor(corpus, ids, stubs, table, stats, source, edges).visit();
  }
  return edges;
}

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/;

class EdgeVisitor {
  readonly #relative: string;

  constructor(
    private readonly corpus: Corpus,
    private readonly ids: Ids,
    private readonly stubs: Stubs,
    private readonly table: EntityTable,
    private readonly stats: ResolutionStats,
    private readonly source: ts.SourceFile,
    private readonly edges: Edge[],
  ) {
    this.#relative = corpus.relative(source.fileName);
  }

  get checker(): ts.TypeChecker {
    return this.corpus.checker;
  }

  visit(): void {
    this.visitReferenceDirectives();
    this.walk(this.source);
  }

  walk(node: ts.Node): void {
    if (ts.isDecorator(node)) {
      // An annotation's arguments ride on the edge; nothing inside it is a call or an access.
      this.annotationUse(node);
      return;
    }
    this.visitNode(node);
    ts.forEachChild(node, (child) => this.walk(child));
  }

  visitNode(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        this.importEdge(node.moduleSpecifier, node);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        this.importEdge(node.moduleReference.expression, node);
      }
    } else if (ts.isCallExpression(node) && isImportCall(node)) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) this.importEdge(argument, node);
      else this.stats.computedImportsDropped += 1;
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      this.invocation(node);
    } else if (ts.isJsxOpeningLikeElement(node)) {
      if (!isIntrinsicTag(node.tagName)) this.invocation(node);
    } else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
      this.heritageEdges(node);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      this.memberAccess(node);
    } else if (ts.isIdentifier(node)) {
      this.identifierUse(node);
    } else if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) && !isHeritage(node)) {
      this.typeReference(node);
    } else if (ts.isTypeQueryNode(node) || ts.isImportTypeNode(node)) {
      this.typeReference(node);
    } else if (ts.isThrowStatement(node)) {
      this.throwSite(node);
    }
  }

  // ------------------------------------------------------------- imports ----

  /** `/// <reference path="…">`: a file-to-file dependency, written literally. */
  visitReferenceDirectives(): void {
    const from = this.ids.moduleOfFile(this.source).key;
    for (const reference of this.source.referencedFiles) {
      const target = slashes(resolve(dirname(this.source.fileName), reference.fileName));
      const line = this.source.getLineAndCharacterOfPosition(reference.pos).line + 1;
      const anchor: Anchor = { file: this.#relative, span: [line, line] };
      let to: Key;
      if (this.corpus.isCorpusFile(target)) {
        const file = this.corpus.program.getSourceFile(target);
        if (file === undefined) continue;
        to = this.ids.moduleOfFile(file).key;
        this.stats.noteImport("resolved");
      } else {
        const relative = this.corpus.relativeOrOutside(target);
        to = { module: escapePath(relative), symbol: "" };
        this.stubs.noteModule(to.module, relative, "outside");
        this.stats.noteImport("unresolved");
      }
      this.push({ kind: "import", from, to, provenance: "declared", anchor });
    }
  }

  importEdge(specifier: ts.StringLiteralLike, site: ts.Node): void {
    const from = this.ids.moduleKeyAround(site);
    const to = this.importTarget(specifier);
    this.push({ kind: "import", from, to, provenance: "declared", anchor: this.anchorOf(site) });
  }

  /**
   * Where a specifier leads: a corpus file or corpus-declared ambient module
   * by its own key; anything installed by the specifier as written (so keys
   * never depend on the install); anything unresolved by the specifier too,
   * as a stub module — the import edge survives (PLAN.md §14.4).
   */
  importTarget(specifier: ts.StringLiteralLike): Key {
    const written = Ids.normalizeSpecifier(specifier.text);
    const workspace = this.corpus.workspaceResolutions.has(`${slashes(this.source.fileName)}|${specifier.text}`);
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const declaration = symbol === undefined ? undefined : this.ids.primaryDeclaration(symbol);
    if (declaration !== undefined) {
      if (ts.isSourceFile(declaration)) {
        const module = this.ids.moduleOfFile(declaration);
        if (module.origin === "corpus" || module.origin === "outside") {
          this.stats.noteImport(workspace ? "workspace" : "resolved");
          return module.key;
        }
      } else if (ts.isModuleDeclaration(declaration) && ts.isStringLiteral(declaration.name)) {
        if (this.corpus.isCorpusFile(declaration.getSourceFile().fileName)) {
          this.stats.noteImport("resolved");
          return this.ids.ambientModuleKey(declaration.name.text);
        }
      }
      // Installed: keyed by the specifier, a stub module.
      this.stats.noteImport("resolved");
      const key: Key = { module: escapePath(written), symbol: "" };
      this.stubs.noteModule(key.module, written, "package");
      return key;
    }
    // The checker did not bind it; standard resolution may still reach a corpus file (a bare require).
    const resolved = this.corpus.resolveSpecifier(specifier.text, this.source.fileName);
    if (resolved !== undefined && this.corpus.isCorpusFile(resolved)) {
      const file = this.corpus.program.getSourceFile(resolved);
      if (file !== undefined) {
        this.stats.noteImport(workspace ? "workspace" : "resolved");
        return this.ids.moduleOfFile(file).key;
      }
    }
    this.stats.noteImport("unresolved");
    const key: Key = { module: escapePath(written), symbol: "" };
    this.stubs.noteModule(key.module, written, "specifier");
    return key;
  }

  // ------------------------------------------------------------ heritage ----

  heritageEdges(node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): void {
    const from = this.ids.declarationKey(node);
    if (from === undefined) return;
    for (const clause of node.heritageClauses ?? []) {
      const kind: EdgeKind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "interfaceImplementation" : "inheritance";
      for (const type of clause.types) {
        const to = this.typeTarget(type.expression);
        if (to === undefined) continue;
        this.push({ kind, from, to, provenance: "declared", anchor: this.anchorOf(type) });
      }
    }
  }

  /** What a written type expression names: a keyed type, an `<unresolved>` stub, or nothing (counted). */
  typeTarget(expression: ts.Expression): Key | undefined {
    const symbol = this.checker.getSymbolAtLocation(expression);
    const resolved = symbol === undefined ? undefined : this.ids.resolveAlias(symbol);
    if (resolved === undefined) {
      // Nothing bound — or an import from a module that resolved to nothing.
      const written = expression.getText(this.source);
      if (IDENTIFIER_PATH.test(written)) {
        this.stats.noteTypeReference(false);
        return this.ids.unresolvedTypeKey(written.replace(/\s+/g, ""));
      }
      this.stats.heritageExpressionsDropped += 1;
      return undefined;
    }
    const key = this.ids.typeKeyOfSymbol(resolved);
    if (key === undefined) {
      this.stats.heritageExpressionsDropped += 1;
      return undefined;
    }
    this.stats.noteTypeReference(true);
    return key;
  }

  // ---------------------------------------------------------- invocations ----

  invocation(node: ts.CallLikeExpression): void {
    const from = this.codeOwner(node);
    if (from === undefined) return;
    const anchor = this.anchorOf(node);
    const callee = calleeOf(node);
    // A call through a receiver the checker could not type has no target.
    if (callee !== undefined && ts.isPropertyAccessExpression(callee) && this.isUntyped(callee.expression)) {
      this.stats.anyReceiversDropped += 1;
      return;
    }
    const signature = this.checker.getResolvedSignature(node);
    const declaration = signature?.declaration;
    if (declaration !== undefined && !ts.isJSDocSignature(declaration)) {
      const to = this.invocationTarget(declaration);
      if (to !== undefined) {
        this.push({ kind: "invocation", from, to, provenance: "declared", anchor });
        this.markOwner(from, "TWithInvocations");
        return;
      }
    }
    // No declaration behind the signature (a synthetic default constructor, a
    // union of methods, a callback parameter): every declaration of the callee's
    // own symbol, or the class itself for `new T()` with no written constructor.
    const targets = this.calleeTargets(node, callee);
    if (targets === "any") {
      this.stats.anyReceiversDropped += 1;
      return;
    }
    if (targets.length === 0) {
      this.stats.indirectCallsDropped += 1;
      return;
    }
    for (const to of targets) this.push({ kind: "invocation", from, to, provenance: "declared", anchor });
    this.markOwner(from, "TWithInvocations");
  }

  /** A resolved signature's declaration as an edge target: the entity itself in the corpus, a fold outside. */
  invocationTarget(declaration: ts.Node): Key | undefined {
    if (this.ids.isCorpus(declaration)) {
      // A signature written on a parameter or local of function type names no
      // declared invocable; the target is unknown statically.
      if (isLocalOrParameter(declaration, this.ids)) return undefined;
      if (ts.isFunctionTypeNode(declaration) || ts.isConstructorTypeNode(declaration)) return undefined;
      if (isKeyedDeclaration(declaration)) return this.ids.declarationKey(declaration);
      // A call or construct signature inside a corpus interface: the interface is the target.
      for (let current: ts.Node | undefined = declaration.parent; current !== undefined; current = current.parent) {
        if (isTypeDeclaration(current)) return this.ids.declarationKey(current);
        if (isKeyedDeclaration(current)) return this.ids.declarationKey(current);
      }
      return undefined;
    }
    return this.ids.valueTargetOfDeclaration(declaration);
  }

  calleeTargets(node: ts.CallLikeExpression, callee: ts.Expression | undefined): Key[] | "any" {
    if (callee === undefined) return [];
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isJsxOpeningLikeElement(node) ? node.tagName : callee;
    if (ts.isPropertyAccessExpression(callee) && this.isUntyped(callee.expression)) return "any";
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    const resolved = symbol === undefined ? undefined : this.ids.resolveAlias(symbol);
    if (resolved === undefined) {
      return ts.isIdentifier(nameNode) && this.isUntyped(nameNode) ? "any" : [];
    }
    if (ts.isNewExpression(node) && resolved.flags & ts.SymbolFlags.Class) {
      const key = this.ids.typeKeyOfSymbol(resolved);
      return key === undefined ? [] : [key];
    }
    // Every corpus declaration of the callee (a union receiver's synthetic
    // symbol holds one per constituent); outside the corpus, the primary one —
    // the lib's `String` is an interface, a var and an augmentation, one entity.
    const declarations = (resolved.declarations ?? []).filter((declaration) => this.ids.isCorpus(declaration));
    const candidates = declarations.length > 0 ? declarations : [this.ids.primaryDeclaration(resolved)].filter((d): d is ts.Declaration => d !== undefined);
    const targets: Key[] = [];
    for (const declaration of candidates) {
      if (!isInvocable(declaration) && !isTypeDeclaration(declaration) && !ts.isVariableDeclaration(declaration) && !ts.isPropertyDeclaration(declaration)) continue;
      const key = isInvocable(declaration) ? this.invocationTarget(declaration) : this.ids.valueTargetOfDeclaration(declaration);
      if (key !== undefined && !targets.some((existing) => keysEqual(existing, key))) targets.push(key);
    }
    return targets;
  }

  // ------------------------------------------------------------- accesses ----

  memberAccess(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    if (this.isCalleeOf(node) || isTypePosition(node)) return;
    const from = this.codeOwner(node);
    if (from === undefined) return;
    if (this.isUntyped(node.expression)) {
      this.stats.anyReceiversDropped += 1;
      return;
    }
    let nameNode: ts.Node;
    if (ts.isPropertyAccessExpression(node)) nameNode = node.name;
    else if (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) nameNode = node.argumentExpression;
    else {
      this.stats.computedAccessesDropped += 1;
      return;
    }
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    this.structuralEdge(node, symbol, from);
  }

  /**
   * A bare identifier in expression position: a module-level variable,
   * property, function or type used as a value. Not when it merely qualifies
   * a member (`Channel.Web`, `Math.round(x)`): the member edge carries that
   * dependency, and folds to the same type when the qualifier is external.
   */
  identifierUse(node: ts.Identifier): void {
    if (!isValueUse(node) || this.isCalleeOf(node) || isQualifier(node)) return;
    const from = this.codeOwner(node);
    if (from === undefined) return;
    const symbol = this.checker.getSymbolAtLocation(node);
    this.structuralEdge(node, symbol, from);
  }

  /** An access to a structural entity, or a reference to a function or type used as a value. */
  structuralEdge(node: ts.Expression, symbol: ts.Symbol | undefined, from: Key): void {
    const resolved = symbol === undefined ? undefined : this.ids.resolveAlias(symbol);
    if (resolved === undefined) return;
    const [isRead, isWrite] = accessFlags(node);
    // An accessor pair: the setter is what a write runs, the getter what a read runs.
    const accessor = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)
      ? (resolved.declarations ?? []).find((d) => (isWrite && !isRead ? ts.isSetAccessorDeclaration(d) : ts.isGetAccessorDeclaration(d)))
      : undefined;
    const declaration = accessor ?? this.ids.primaryDeclaration(resolved);
    if (declaration === undefined) return;
    if (this.ids.isCorpus(declaration) && isLocalOrParameter(declaration, this.ids)) return;
    const anchor = this.anchorOf(node);
    if (resolved.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Variable | ts.SymbolFlags.EnumMember | ts.SymbolFlags.Accessor)) {
      const to = this.ids.valueTargetOfDeclaration(declaration);
      if (to === undefined) return;
      this.push({ kind: "access", from, to, provenance: "declared", anchor, isRead, isWrite });
      this.markOwner(from, "TWithAccesses");
      return;
    }
    if (resolved.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method | ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)) {
      const to = resolved.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum) ? this.ids.typeKeyOfSymbol(resolved) : this.ids.valueTargetOfDeclaration(declaration);
      if (to === undefined) return;
      this.push({ kind: "reference", from, to, provenance: "declared", anchor });
    }
  }

  // ----------------------------------------------------------- references ----

  typeReference(node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments | ts.TypeQueryNode | ts.ImportTypeNode): void {
    const from = this.referenceOwner(node);
    if (from === undefined) return;
    const nameNode = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : node.qualifier;
    if (nameNode === undefined) return;
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    const resolved = symbol === undefined ? undefined : this.ids.resolveAlias(symbol);
    let to: Key | undefined;
    if (resolved === undefined) {
      const written = nameNode.getText(this.source);
      if (!IDENTIFIER_PATH.test(written)) return;
      this.stats.noteTypeReference(false);
      to = this.ids.unresolvedTypeKey(written.replace(/\s+/g, ""));
    } else {
      if (resolved.flags & ts.SymbolFlags.TypeParameter) return;
      to = this.ids.typeKeyOfSymbol(resolved);
      if (to === undefined) {
        // `typeof x` on a value, a namespace qualifier: not a type reference this model keys.
        if (ts.isTypeQueryNode(node) || ts.isImportTypeNode(node)) return;
        if (!(resolved.flags & ts.SymbolFlags.Type)) return;
        this.stats.noteTypeReference(false);
        return;
      }
      this.stats.noteTypeReference(true);
    }
    this.push({ kind: "reference", from, to, provenance: "declared", anchor: this.anchorOf(node) });
  }

  // ----------------------------------------------------------- decorators ----

  annotationUse(node: ts.Decorator): void {
    const target = node.parent;
    const from = this.decoratedKey(target);
    if (from === undefined) return;
    const expression = node.expression;
    const callee = ts.isCallExpression(expression) ? expression.expression : expression;
    const symbol = this.checker.getSymbolAtLocation(callee);
    const resolved = symbol === undefined ? undefined : this.ids.resolveAlias(symbol);
    let to: Key | undefined;
    if (resolved === undefined) {
      const written = callee.getText(this.source);
      if (!IDENTIFIER_PATH.test(written)) return;
      to = this.ids.unresolvedTypeKey(written.replace(/\s+/g, ""));
    } else {
      to = this.ids.valueTargetOfSymbol(resolved);
    }
    if (to === undefined) return;
    const args = ts.isCallExpression(expression) ? decoratorArguments(expression, this.ids) : [];
    this.push({ kind: "annotationUse", from, to, provenance: "declared", anchor: this.anchorOf(node), arguments: args });
  }

  /** What a decorator decorates: the class, member or parameter entity. */
  decoratedKey(target: ts.Node): Key | undefined {
    if (ts.isClassExpression(target) || isKeyedDeclaration(target)) return this.ids.declarationKey(target);
    return undefined;
  }

  // ---------------------------------------------------------------- throws ----

  throwSite(node: ts.ThrowStatement): void {
    const from = this.codeOwner(node);
    if (from === undefined) return;
    const type = this.checker.getTypeAtLocation(node.expression);
    const symbol = type.getSymbol();
    const to = symbol === undefined || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? undefined : this.ids.typeKeyOfSymbol(symbol);
    if (to === undefined) {
      this.stats.throwsDropped += 1;
      return;
    }
    this.push({ kind: "throws", from, to, provenance: "declared", anchor: this.anchorOf(node) });
  }

  // --------------------------------------------------------------- owners ----

  /**
   * The narrowest declared owner of CODE: the enclosing invocable; else a
   * property, enum member or module-level variable whose initializer this is;
   * else the class (a static block, a decorator argument), namespace or module.
   * Locals and parameters never own edges.
   */
  codeOwner(node: ts.Node): Key | undefined {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (isInvocable(current)) return this.ids.declarationKey(current);
      if (ts.isPropertyDeclaration(current) || ts.isEnumMember(current) || ts.isPropertyAssignment(current)) {
        const key = this.ids.declarationKey(current);
        if (key !== undefined) return key;
      }
      if (ts.isVariableDeclaration(current) && !this.ids.isLocal(current)) {
        const key = this.ids.declarationKey(current);
        if (key !== undefined) return key;
      }
      if (ts.isClassLike(current) || ts.isModuleDeclaration(current) || ts.isSourceFile(current)) {
        return this.ids.declarationKey(current);
      }
    }
    return undefined;
  }

  /** The narrowest declared owner of a written TYPE: a parameter's type from the parameter, a field's from the field. */
  referenceOwner(node: ts.Node): Key | undefined {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      // An overload signature's parameter is no entity: its type is the implementation's dependency.
      if (ts.isParameter(current) && this.ids.isOverloadSignature(current.parent)) continue;
      if (ts.isParameter(current) || ts.isPropertyDeclaration(current) || ts.isPropertySignature(current) || ts.isEnumMember(current)) {
        const key = this.ids.declarationKey(current);
        if (key !== undefined) return key;
      }
      if (ts.isVariableDeclaration(current)) {
        if (this.ids.isLocal(current)) continue;
        const key = this.ids.declarationKey(current);
        if (key !== undefined) return key;
      }
      if (isInvocable(current) || isTypeDeclaration(current) || ts.isClassExpression(current)) {
        const key = this.ids.declarationKey(current);
        if (key !== undefined) return key;
      }
      if (ts.isModuleDeclaration(current) || ts.isSourceFile(current)) return this.ids.declarationKey(current);
    }
    return undefined;
  }

  /** Marker traits an owner earns by owning edges (variables, properties, modules, namespaces, classes). */
  markOwner(owner: Key, trait: "TWithInvocations" | "TWithAccesses"): void {
    this.table.mark(owner, trait);
  }

  // ------------------------------------------------------------- helpers ----

  isCalleeOf(node: ts.Node): boolean {
    const parent = node.parent;
    return (
      parent !== undefined &&
      ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node ||
        (ts.isTaggedTemplateExpression(parent) && parent.tag === node) ||
        (ts.isDecorator(parent) && parent.expression === node))
    );
  }

  /** `any`, `unknown` or an error type: the checker has no shape to bind against. */
  isUntyped(expression: ts.Expression): boolean {
    const type = this.checker.getTypeAtLocation(expression);
    return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  }

  push(edge: Edge): void {
    if (keysEqual(edge.from, edge.to)) {
      this.stats.selfEdgesDropped += 1;
      return;
    }
    this.edges.push(edge);
  }

  anchorOf(node: ts.Node): Anchor {
    const start = this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    const end = this.source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { file: this.#relative, span: [start, Math.max(start, end)] };
  }
}

// ----------------------------------------------------------------- syntax ----

/** `import("x")`, or a bare `require("x")` call. */
function isImportCall(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
}

function calleeOf(node: ts.CallLikeExpression): ts.Expression | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node.expression;
  if (ts.isTaggedTemplateExpression(node)) return node.tag;
  if (ts.isJsxOpeningLikeElement(node)) return node.tagName as ts.Expression;
  return undefined;
}

/** `<div>` is an intrinsic element; `<Row>` and `<ui.Row>` name a component. */
function isIntrinsicTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text);
}

function isHeritage(node: ts.ExpressionWithTypeArguments): boolean {
  return node.parent !== undefined && ts.isHeritageClause(node.parent);
}

/** A member access written in a type (`typeof a.b`) is a reference, not an access. */
function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return true;
    if (ts.isStatement(current) || ts.isExpression(current) && !ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
  }
  return false;
}

/** An identifier that READS a value: not a declaration name, a property name, a type name, a label or an import name. */
function isValueUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  // The `name` slot of anything — a declaration, a property assignment, an
  // enum member, a member access, a JSX attribute — is not a use of a value.
  if ((parent as { name?: ts.Node }).name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isImportTypeNode(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isNamespaceExport(parent)) return false;
  if (ts.isJsxAttribute(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isHeritageClause(parent.parent ?? parent) || ts.isExpressionWithTypeArguments(parent)) return false;
  if (ts.isTypeParameterDeclaration(parent) || ts.isTypePredicateNode(parent)) return false;
  if (ts.isJsxOpeningLikeElement(parent) || ts.isJsxClosingElement(parent)) return false;
  return isTypePosition(node) === false;
}

/** The object of a member access: `X` in `X.y` or `X[y]`. */
function isQualifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ((ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
      (ts.isElementAccessExpression(parent) && parent.expression === node))
  );
}

/** Whether an expression is read, written, or both, from the syntax around it. */
function accessFlags(node: ts.Expression): [boolean, boolean] {
  let current: ts.Node = node;
  while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent))) current = current.parent;
  const parent = current.parent;
  if (parent === undefined) return [true, false];
  if (ts.isBinaryExpression(parent) && parent.left === current) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsToken) return [false, true];
    if (operator >= ts.SyntaxKind.FirstCompoundAssignment && operator <= ts.SyntaxKind.LastCompoundAssignment) return [true, true];
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
    return [true, true];
  }
  if (ts.isDeleteExpression(parent)) return [false, true];
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current) return [false, true];
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isPropertyAssignment(parent) && parent.initializer === current) {
    // A destructuring assignment target: `[a.x] = …` / `({ y: a.x } = …)`.
    let outer: ts.Node | undefined = parent;
    while (outer !== undefined && (ts.isArrayLiteralExpression(outer) || ts.isObjectLiteralExpression(outer) || ts.isPropertyAssignment(outer) || ts.isSpreadElement(outer) || ts.isSpreadAssignment(outer))) outer = outer.parent;
    if (outer !== undefined && ts.isBinaryExpression(outer) && outer.operatorToken.kind === ts.SyntaxKind.EqualsToken) return [false, true];
  }
  return [true, false];
}

export { boundName };
