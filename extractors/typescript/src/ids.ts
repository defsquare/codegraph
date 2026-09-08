import { isBuiltin } from "node:module";
import ts from "typescript";
import type { Corpus } from "./corpus.js";
import {
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
 * here. A declaration's key is its owner's key plus its own escaped name; the
 * owner chain ends at a file (module = the escaped root-relative path), an
 * ambient `declare module "x"` (module = the normalised name), the compiler's
 * lib (`<lib>`) or an installed package (its npm name). A stub's key has the
 * same shape as a declared entity's, on purpose: membership is the corpus
 * file set, never the key's shape.
 */
export class Ids {
  readonly #moduleOfFile = new Map<string, ModuleOf>();

  constructor(
    private readonly corpus: Corpus,
    private readonly stubs: Stubs,
  ) {}

  /** `fs` and `node:fs` are one module in fact; `module.builtinModules` says which names those are. */
  static normalizeSpecifier(specifier: string): string {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    return isBuiltin(bare) || isBuiltin(specifier) ? `node:${bare}` : specifier;
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

  /**
   * The key of a declaration node, or undefined when the node is not an
   * entity this extractor keys. Uniform over corpus and external files: the
   * owner chain decides the module, so a class inside `declare module "fs"`
   * in @types/node lands in `node:fs`, exactly like an import of it.
   */
  declarationKey(node: ts.Node): Key | undefined {
    if (ts.isSourceFile(node)) return this.moduleOfFile(node).key;
    if (ts.isModuleDeclaration(node)) {
      if (node.flags & ts.NodeFlags.GlobalAugmentation) return this.ownerKey(node);
      if (ts.isStringLiteral(node.name)) return this.ambientModuleKey(node.name.text);
      const owner = this.ownerKey(node);
      return owner === undefined ? undefined : memberKey(owner, escapeName(node.name.text));
    }
    if (isKeyedDeclaration(node)) {
      const owner = this.ownerKey(node);
      if (owner === undefined) return undefined;
      const name = declarationName(node);
      return name === undefined ? undefined : memberKey(owner, escapeName(name));
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
      if (isKeyedDeclaration(current)) return this.declarationKey(current);
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
   * Aliases (`import { X as Y }`, `export { X }`) resolve to what they name;
   * undefined when that is nothing — an import from a module that did not
   * resolve aliases the checker's `unknown` symbol, which declares nothing.
   */
  resolveAlias(symbol: ts.Symbol): ts.Symbol | undefined {
    let current = symbol;
    for (let hops = 0; hops < 16 && current.flags & ts.SymbolFlags.Alias; hops += 1) {
      const target = this.corpus.checker.getAliasedSymbol(current);
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
    if (resolved === undefined) return undefined;
    // A merged symbol's TYPE declaration decides the kind (class + interface
    // merging is one class); an alias to a variable holding a class is none.
    const declaration = this.primaryDeclaration(resolved, (candidate) => typeKindOf(candidate) !== undefined);
    if (declaration === undefined) return undefined;
    const kind = typeKindOf(declaration);
    if (kind === undefined) return undefined;
    const key = this.declarationKey(declaration);
    if (key === undefined) return undefined;
    if (!this.corpus.isCorpusFile(declaration.getSourceFile().fileName)) {
      const name = declarationName(declaration) ?? unescape(key.symbol.split(".").at(-1) ?? "");
      // The stub's spaces follow its KIND, not the merged symbol: the lib pairs
      // `interface Error` with `declare var Error`, and an interface stub
      // claiming the value space is a composition the profile refuses.
      this.stubs.noteType(key, kind, name, spaceOfTypeKind(kind, declaration));
    }
    return key;
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


/** The declaration kinds M13a keys; members join in M13b. */
export function isKeyedDeclaration(node: ts.Node): node is ts.Declaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  );
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

export function typeKindOf(declaration: ts.Declaration): Kind | undefined {
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
