import { isBuiltin } from "node:module";
import ts from "typescript";
import type { Corpus } from "./corpus.js";
import {
  disambiguated,
  escapeName,
  escapePath,
  LIB_MODULE,
  memberKey,
  moduleKey,
  UNRESOLVED_MODULE,
  unescape,
  type Key,
} from "./model/keys.js";
import type { Kind, Space } from "./model/model.js";
import type { Stubs } from "./stubs.js";
import { slashes } from "./paths.js";

/** Where a declaration lives, which decides its module and whether it is a stub. */
export type Origin = "corpus" | "ambient" | "package" | "lib" | "outside";

export interface ModuleOf {
  readonly key: Key;
  readonly origin: Origin;
}

/**
 * THE TypeScript id scheme (PLAN.md §14.3): every key in the model comes from
 * here. A declaration's key is its owner's key plus its own escaped name, or
 * a disambiguator below the owner for what has no name of its own; the owner
 * chain ends at a file (module = the escaped root-relative path), an ambient
 * `declare module "x"` (module = the normalised name), the compiler's lib
 * (`<lib>`) or an installed package (its npm name). A stub's key has the same
 * shape as a declared entity's, on purpose: membership is the corpus file
 * set, never the key's shape.
 *
 *   member          Type.name              overloads are one declaration: no parameter list
 *   static twin     Type.name#static       only beside an instance member of that name
 *   accessor pair   Type.name#get / #set   only when both are written
 *   nameless        owner#line:column      arrows, function and class expressions
 *   parameter       owner#param:name
 *   local           owner#local:name:line:column
 *   nested function owner#fn:name          nested type: owner#type:name
 */
export class Ids {
  readonly #moduleOfFile = new Map<string, ModuleOf>();
  readonly #keys = new Map<ts.Node, Key | undefined>();

  constructor(
    private readonly corpus: Corpus,
    private readonly stubs: Stubs,
  ) {}

  /** `fs` and `node:fs` are one module in fact; `module.builtinModules` says which names those are. */
  static normalizeSpecifier(specifier: string): string {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    return isBuiltin(bare) || isBuiltin(specifier) ? `node:${bare}` : specifier;
  }

  get checker(): ts.TypeChecker {
    return this.corpus.checker;
  }

  /** The module a file declares: corpus path, lib, package, or a path outside the roots. */
  moduleOfFile(file: ts.SourceFile): ModuleOf {
    const fileName = slashes(file.fileName);
    const cached = this.#moduleOfFile.get(fileName);
    if (cached !== undefined) return cached;
    let result: ModuleOf;
    if (this.corpus.isCorpusFile(fileName)) {
      result = { key: moduleKey(escapePath(this.corpus.relative(fileName))), origin: "corpus" };
    } else if (this.corpus.program.isSourceFileDefaultLibrary(file)) {
      result = { key: moduleKey(LIB_MODULE), origin: "lib" };
      this.stubs.noteModule(LIB_MODULE, LIB_MODULE, "lib");
    } else {
      const packageName = packageNameOf(fileName);
      if (packageName !== undefined) {
        result = { key: moduleKey(escapePath(packageName)), origin: "package" };
        this.stubs.noteModule(result.key.module, packageName, "package");
      } else {
        const relative = this.corpus.relativeOrOutside(fileName);
        result = { key: moduleKey(escapePath(relative)), origin: "outside" };
        this.stubs.noteModule(result.key.module, relative, "outside");
      }
    }
    this.#moduleOfFile.set(fileName, result);
    return result;
  }

  /** The module an ambient `declare module "x"` block declares, wherever it is written. */
  ambientModuleKey(name: string): Key {
    return moduleKey(escapePath(Ids.normalizeSpecifier(name)));
  }

  isCorpus(node: ts.Node): boolean {
    return this.corpus.isCorpusFile(node.getSourceFile().fileName);
  }

  // ------------------------------------------------------------ declarations ----

  /**
   * The key of a declaration node, or undefined when the node is not an
   * entity this extractor keys. Uniform over corpus and external files: the
   * owner chain decides the module, so a class inside `declare module "fs"`
   * in @types/node lands in `node:fs`, exactly like an import of it.
   */
  declarationKey(node: ts.Node): Key | undefined {
    if (this.#keys.has(node)) return this.#keys.get(node);
    const key = this.computeKey(node);
    this.#keys.set(node, key);
    return key;
  }

  private computeKey(node: ts.Node): Key | undefined {
    if (ts.isSourceFile(node)) return this.moduleOfFile(node).key;
    if (ts.isModuleDeclaration(node)) {
      if (node.flags & ts.NodeFlags.GlobalAugmentation) return this.ownerKey(node);
      if (ts.isStringLiteral(node.name)) return this.ambientModuleKey(node.name.text);
      const owner = this.ownerKey(node);
      if (owner === undefined) return undefined;
      return this.underInvocable(node)
        ? disambiguated(owner, `type:${escapeName(node.name.text)}`)
        : memberKey(owner, escapeName(node.name.text));
    }
    if (ts.isClassExpression(node)) {
      const binding = boundName(node);
      if (binding === undefined) return undefined;
      const owner = this.ownerKey(binding);
      return owner === undefined ? undefined : this.namedBelow(owner, node, declarationName(binding) ?? "");
    }
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) return undefined;
      const initializer = unwrap(node.initializer);
      // `const A = class {}`: the variable IS the class; one key, the class's.
      if (initializer !== undefined && ts.isClassExpression(initializer)) return this.declarationKey(initializer);
      const owner = this.ownerKey(node);
      if (owner === undefined) return undefined;
      return this.isLocal(node)
        ? disambiguated(owner, `local:${escapeName(node.name.text)}:${this.position(node.name)}`)
        : memberKey(owner, escapeName(node.name.text));
    }
    if (ts.isBindingElement(node)) {
      if (!ts.isIdentifier(node.name)) return undefined;
      const root = bindingRoot(node);
      const owner = root === undefined ? undefined : this.ownerKey(root);
      if (root === undefined || owner === undefined) return undefined;
      if (ts.isParameter(root)) return disambiguated(owner, `param:${escapeName(node.name.text)}`);
      return this.isLocal(root)
        ? disambiguated(owner, `local:${escapeName(node.name.text)}:${this.position(node.name)}`)
        : memberKey(owner, escapeName(node.name.text));
    }
    if (ts.isParameter(node)) {
      if (!ts.isIdentifier(node.name) || node.name.text === "this") return undefined;
      const owner = this.ownerKey(node);
      return owner === undefined ? undefined : disambiguated(owner, `param:${escapeName(node.name.text)}`);
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const owner = this.ownerKey(node);
      return owner === undefined ? undefined : disambiguated(owner, this.position(node));
    }
    if (ts.isConstructorDeclaration(node)) {
      const owner = this.ownerKey(node);
      return owner === undefined ? undefined : memberKey(owner, "constructor");
    }
    if (isNamedMember(node) || ts.isFunctionDeclaration(node) || isTypeDeclaration(node)) {
      const owner = this.ownerKey(node);
      if (owner === undefined) return undefined;
      const name = declarationName(node);
      if (name === undefined) return undefined;
      const base = this.namedBelow(owner, node, name);
      const twin = this.twinTag(node);
      return twin === undefined ? base : disambiguated(base, twin);
    }
    return undefined;
  }

  /** A named declaration below its owner: a member, or a nested function/type inside an invocable. */
  private namedBelow(owner: Key, node: ts.Node, name: string): Key {
    if (this.underInvocable(node)) {
      const tag = ts.isFunctionDeclaration(node)
        ? "fn"
        : isTypeDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node)
          ? "type"
          : undefined;
      if (tag !== undefined) return disambiguated(owner, `${tag}:${escapeName(name)}`);
    }
    return memberKey(owner, escapeName(name));
  }

  /** `#static` beside an instance twin, `#get`/`#set` for a written pair — else nothing. */
  private twinTag(node: ts.Node): string | undefined {
    if (!ts.isClassElement(node) || node.parent === undefined || !ts.isClassLike(node.parent)) return undefined;
    const name = declarationName(node);
    if (name === undefined) return undefined;
    const classSymbol = this.checker.getTypeAtLocation(node.parent).getSymbol();
    if (classSymbol === undefined) return undefined;
    const isStatic = (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
    const escaped = ts.escapeLeadingUnderscores(name);
    if (isStatic && classSymbol.members?.has(escaped)) return "static";
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const table = isStatic ? classSymbol.exports : classSymbol.members;
      const declarations = table?.get(escaped)?.declarations ?? [];
      const hasGet = declarations.some(ts.isGetAccessorDeclaration);
      const hasSet = declarations.some(ts.isSetAccessorDeclaration);
      if (hasGet && hasSet) return ts.isGetAccessorDeclaration(node) ? "get" : "set";
    }
    return undefined;
  }

  /** The nearest keyed ancestor's key — the module for a top-level declaration. */
  ownerKey(node: ts.Node): Key | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isSourceFile(current)) return this.moduleOfFile(current).key;
      if (ts.isModuleDeclaration(current)) {
        if (current.flags & ts.NodeFlags.GlobalAugmentation) {
          current = current.parent;
          continue;
        }
        return this.declarationKey(current);
      }
      if (ts.isObjectLiteralExpression(current)) {
        // Members of a BOUND literal belong to the binding; an unbound one is transparent.
        const binding = boundName(current);
        if (binding !== undefined) return this.declarationKey(binding);
        current = current.parent;
        continue;
      }
      if (isKeyedDeclaration(current)) {
        const key = this.declarationKey(current);
        if (key !== undefined) return key;
      }
      current = current.parent;
    }
    return undefined;
  }

  /** The module a statement is written in: the file, or the ambient module block around it. */
  moduleKeyAround(node: ts.Node): Key {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      if (ts.isSourceFile(current)) return this.moduleOfFile(current).key;
      if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) {
        return this.ambientModuleKey(current.name.text);
      }
      current = current.parent;
    }
    throw new Error("a node with no source file");
  }

  /**
   * A signature written beside an implementation of the same name in the
   * same container: not an entity of its own (overloads are one declaration),
   * so nothing written on it — a parameter, a type — is either.
   */
  isOverloadSignature(node: ts.Node): boolean {
    if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isConstructorDeclaration(node)) return false;
    if (node.body !== undefined) return false;
    const symbol = ts.isConstructorDeclaration(node)
      ? this.checker.getTypeAtLocation(node.parent).getSymbol()?.members?.get(ts.InternalSymbolName.Constructor)
      : node.name === undefined
        ? undefined
        : this.checker.getSymbolAtLocation(node.name);
    return (symbol?.declarations ?? []).some(
      (declaration) => ts.isFunctionLike(declaration) && (declaration as ts.FunctionLikeDeclaration).body !== undefined,
    );
  }

  /** `line:column` of a node's first token, 1-based: a source fact, and two can start on one line. */
  position(node: ts.Node): string {
    const file = node.getSourceFile();
    const at = file.getLineAndCharacterOfPosition(node.getStart(file));
    return `${at.line + 1}:${at.character + 1}`;
  }

  /** A declaration written inside an invocable's body, not directly in a module, namespace or type. */
  underInvocable(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (
        ts.isSourceFile(current) ||
        ts.isModuleBlock(current) ||
        ts.isClassLike(current) ||
        ts.isInterfaceDeclaration(current)
      ) {
        return false;
      }
      if (ts.isObjectLiteralExpression(current) && boundName(current) !== undefined) return false;
      if (isInvocable(current)) return true;
      current = current.parent;
    }
    return false;
  }

  /** A variable that is not a member of a module or namespace body. */
  isLocal(declaration: ts.Node): boolean {
    const list = declaration.parent;
    const statement = list?.parent;
    if (statement === undefined || !ts.isVariableStatement(statement)) return true;
    const container = statement.parent;
    return !(ts.isSourceFile(container) || ts.isModuleBlock(container));
  }

  // ---------------------------------------------------------------- symbols ----

  /**
   * Aliases (`import { X as Y }`, `export { X }`) resolve to what they name;
   * undefined when that is nothing — an import from a module that did not
   * resolve aliases the checker's `unknown` symbol, which declares nothing.
   */
  resolveAlias(symbol: ts.Symbol): ts.Symbol | undefined {
    let current = symbol;
    for (let hops = 0; hops < 16 && current.flags & ts.SymbolFlags.Alias; hops += 1) {
      const target = this.checker.getAliasedSymbol(current);
      if (target === current) break;
      current = target;
    }
    return isUnknownSymbol(current) ? undefined : current;
  }

  /**
   * The declaration an edge to a merged symbol lands on: the first corpus
   * declaration in canonical file order, else the first external one — a
   * deterministic choice, named in the profile note as one.
   */
  primaryDeclaration(
    symbol: ts.Symbol,
    accept: (declaration: ts.Declaration) => boolean = () => true,
  ): ts.Declaration | undefined {
    const declarations = (symbol.declarations ?? []).filter(accept);
    if (declarations.length === 0) return undefined;
    const ranked = declarations
      .map((declaration) => {
        const file = declaration.getSourceFile();
        const corpus = this.corpus.isCorpusFile(file.fileName);
        return {
          declaration,
          rank: (corpus ? 0 : 10) + mergeRank(declaration),
          path: corpus ? this.corpus.relative(file.fileName) : slashes(file.fileName),
          pos: declaration.pos,
        };
      })
      .sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.pos - b.pos);
    return ranked[0]?.declaration;
  }

  /**
   * The key of what a TYPE symbol names, registering a stub when it is
   * external. Undefined when the symbol names no type declaration this
   * extractor keys (a variable holding a class, a type parameter).
   */
  typeKeyOfSymbol(symbol: ts.Symbol): Key | undefined {
    const resolved = this.resolveAlias(symbol);
    if (resolved === undefined || resolved.flags & ts.SymbolFlags.TypeParameter) return undefined;
    // A merged symbol's TYPE declaration decides the kind (class + interface
    // merging is one class); an alias to a variable holding a class is none.
    const declaration = this.primaryDeclaration(resolved, (candidate) => typeKindOf(candidate) !== undefined);
    if (declaration === undefined) return undefined;
    return this.typeKeyOfDeclaration(declaration);
  }

  /** The key of a type declaration, registering a stub when it is external. */
  typeKeyOfDeclaration(declaration: ts.Node): Key | undefined {
    const kind = typeKindOf(declaration);
    if (kind === undefined) return undefined;
    const key = this.declarationKey(declaration);
    if (key === undefined) return undefined;
    if (!this.isCorpus(declaration)) {
      const name = declarationName(declaration) ?? unescape(key.symbol.split(".").at(-1) ?? "");
      // The stub's spaces follow its KIND, not the merged symbol: the lib pairs
      // `interface Error` with `declare var Error`, and an interface stub
      // claiming the value space is a composition the profile refuses.
      this.stubs.noteType(key, kind, name, spaceOfTypeKind(kind, declaration as ts.Declaration));
    }
    return key;
  }

  /**
   * The key an edge to a VALUE symbol lands on: a corpus declaration by its
   * own key; an external member folded to its type's stub, an external free
   * function or variable folded to its module's stub — the smallest degraded
   * container a module-level value has. Undefined for locals and parameters
   * (never edge targets) and for what is not an entity at all.
   */
  valueTargetOfSymbol(symbol: ts.Symbol): Key | undefined {
    const resolved = this.resolveAlias(symbol);
    if (resolved === undefined) return undefined;
    const declaration = this.primaryDeclaration(resolved);
    if (declaration === undefined) return undefined;
    return this.valueTargetOfDeclaration(declaration);
  }

  valueTargetOfDeclaration(declaration: ts.Node): Key | undefined {
    if (this.isCorpus(declaration)) {
      // A parameter property (`constructor(readonly x: T)`) is the field it declares.
      if (ts.isParameter(declaration) && isParameterProperty(declaration)) return this.parameterPropertyKey(declaration);
      if (isLocalOrParameter(declaration, this)) return undefined;
      return this.declarationKey(declaration);
    }
    // External: fold to the nearest type, else to the module.
    for (let current: ts.Node | undefined = declaration; current !== undefined; current = current.parent) {
      if (isTypeDeclaration(current) || ts.isClassExpression(current)) {
        const key = this.typeKeyOfDeclaration(current);
        if (key !== undefined) return key;
      }
      // A variable typed by an interface (`declare var Math: Math`): the interface is the type.
      if (ts.isVariableDeclaration(current) && current.type !== undefined) {
        const typeSymbol = this.checker.getTypeAtLocation(current.type).getSymbol();
        const typeKey = typeSymbol === undefined ? undefined : this.typeKeyOfSymbol(typeSymbol);
        if (typeKey !== undefined) return typeKey;
      }
      if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)) {
        const key = this.ambientModuleKey(current.name.text);
        this.stubs.noteModule(key.module, Ids.normalizeSpecifier(current.name.text), "package");
        return key;
      }
      if (ts.isSourceFile(current)) return this.moduleOfFile(current).key;
    }
    return undefined;
  }

  /** The field a parameter property declares: a member of the constructor's class. */
  parameterPropertyKey(parameter: ts.ParameterDeclaration): Key | undefined {
    if (!ts.isIdentifier(parameter.name) || !ts.isConstructorDeclaration(parameter.parent)) return undefined;
    const owner = this.ownerKey(parameter.parent);
    return owner === undefined ? undefined : memberKey(owner, escapeName(parameter.name.text));
  }

  /** A name the checker could not bind: a stub in `<unresolved>`, named as written. */
  unresolvedTypeKey(writtenName: string): Key {
    const symbol = writtenName
      .split(".")
      .map((segment) => escapeName(segment.trim()))
      .join(".");
    const key: Key = { module: UNRESOLVED_MODULE, symbol };
    this.stubs.noteModule(UNRESOLVED_MODULE, UNRESOLVED_MODULE, "unresolved");
    this.stubs.noteType(key, "class", writtenName.split(".").at(-1)?.trim() ?? writtenName, undefined);
    return key;
  }
}

// --------------------------------------------------------------- helpers ----

/** The checker's placeholder for what it could not bind: no declarations, the reserved name. */
export function isUnknownSymbol(symbol: ts.Symbol): boolean {
  return (symbol.declarations === undefined || symbol.declarations.length === 0) && symbol.name === "unknown";
}

/**
 * Declaration merging's pecking order (PLAN.md §14.3): when one symbol has
 * declarations of several kinds, the entity takes the strongest — a class
 * merged with an interface is a class, a function merged with a namespace a
 * function. Lower is stronger.
 */
export function mergeRank(declaration: ts.Node): number {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return 0;
  if (ts.isEnumDeclaration(declaration)) return 1;
  if (ts.isFunctionDeclaration(declaration)) return 2;
  if (ts.isVariableDeclaration(declaration)) return 3;
  if (ts.isInterfaceDeclaration(declaration)) return 4;
  if (ts.isTypeAliasDeclaration(declaration)) return 5;
  if (ts.isModuleDeclaration(declaration)) return 6;
  return 7;
}

export function isTypeDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  );
}

export function isInvocable(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Members with a written name: methods, accessors, properties, enum members.
 * A member of an anonymous type literal (`{ order: Order }`) is none: the
 * literal is no entity, so neither are its parts.
 */
export function isNamedMember(node: ts.Node): boolean {
  if ((ts.isPropertySignature(node) || ts.isMethodSignature(node)) && node.parent !== undefined && ts.isTypeLiteralNode(node.parent)) {
    return false;
  }
  return (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isEnumMember(node)
  );
}

/** Every declaration kind this extractor keys. */
export function isKeyedDeclaration(node: ts.Node): boolean {
  return (
    isTypeDeclaration(node) ||
    ts.isClassExpression(node) ||
    isInvocable(node) ||
    isNamedMember(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  );
}

/** `constructor(private x: T)`: a parameter that declares a field. */
export function isParameterProperty(parameter: ts.ParameterDeclaration): boolean {
  return (ts.getCombinedModifierFlags(parameter) & ts.ModifierFlags.ParameterPropertyModifier) !== 0;
}

/** Locals and parameters are entities but never edge targets (the C# rule). */
export function isLocalOrParameter(declaration: ts.Node, ids: Ids): boolean {
  if (ts.isParameter(declaration)) return !isParameterProperty(declaration);
  if (ts.isVariableDeclaration(declaration)) return ids.isLocal(declaration);
  if (ts.isBindingElement(declaration)) {
    const root = bindingRoot(declaration);
    return root === undefined || ts.isParameter(root) || ids.isLocal(root);
  }
  return false;
}

/** The parameter or variable a destructured binding element belongs to. */
export function bindingRoot(element: ts.BindingElement): ts.ParameterDeclaration | ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = element.parent;
  while (current !== undefined) {
    if (ts.isParameter(current) || ts.isVariableDeclaration(current)) return current;
    if (!ts.isBindingElement(current) && !ts.isObjectBindingPattern(current) && !ts.isArrayBindingPattern(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/** `x as const`, `(x)`, `x satisfies T`, `x!` — the expression underneath. */
export function unwrap(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (current !== undefined) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else return current;
  }
  return current;
}

/** The variable or property a class expression or object literal is the initializer of. */
export function boundName(
  expression: ts.Expression,
): ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertyAssignment | undefined {
  let current: ts.Node = expression;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (parent === undefined) return undefined;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.initializer === current
  ) {
    if (ts.isVariableDeclaration(parent) && !ts.isIdentifier(parent.name)) return undefined;
    return parent;
  }
  return undefined;
}

/** The written name of a declaration, `default` for a nameless default export. */
export function declarationName(node: ts.Node): string | undefined {
  const name = ts.getNameOfDeclaration(node as ts.Declaration);
  if (name === undefined) {
    if (ts.canHaveModifiers(node) && ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) {
      return "default";
    }
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`;
  return undefined;
}

export function typeKindOf(declaration: ts.Node): Kind | undefined {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Abstract ? "abstractClass" : "class";
  }
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "typeAlias";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  return undefined;
}

export function spaceOfTypeKind(kind: Kind, declaration: ts.Declaration): Space[] {
  switch (kind) {
    case "interface":
    case "typeAlias":
      return ["type"];
    case "enum":
      return ts.isEnumDeclaration(declaration) && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Const
        ? ["type"]
        : ["type", "value"];
    default:
      return ["type", "value"];
  }
}

/** `…/node_modules/@scope/name/…` → `@scope/name`; the LAST node_modules segment wins (nested installs). */
export function packageNameOf(fileName: string): string | undefined {
  const marker = "/node_modules/";
  const at = fileName.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = fileName.slice(at + marker.length).split("/");
  const first = rest[0];
  if (first === undefined || first === "") return undefined;
  if (first.startsWith("@")) {
    const second = rest[1];
    return second === undefined || second === "" ? undefined : `${first}/${second}`;
  }
  return first;
}
