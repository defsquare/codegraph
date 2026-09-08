import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { Corpus } from "./corpus.js";
import { Ids } from "./ids.js";
import { escapePath, keysEqual, type Key } from "./model/keys.js";
import type { Anchor, Edge, EdgeKind } from "./model/model.js";
import { slashes } from "./paths.js";
import type { ResolutionStats } from "./stats.js";
import type { Stubs } from "./stubs.js";

/**
 * Pass 3 — edges, every one `declared` and anchored at the site that wrote
 * it. M13a: imports (module → module, the first-class cross-language layer)
 * and heritage (`extends`, `implements`). Calls, accesses, references,
 * decorators and throw sites arrive in M13b.
 */
export function extractEdges(corpus: Corpus, ids: Ids, stubs: Stubs, stats: ResolutionStats): Edge[] {
  const edges: Edge[] = [];
  for (const file of corpus.files) {
    const source = corpus.program.getSourceFile(file);
    if (source === undefined) continue;
    new EdgeVisitor(corpus, ids, stubs, stats, source, edges).visit();
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
    private readonly stats: ResolutionStats,
    private readonly source: ts.SourceFile,
    private readonly edges: Edge[],
  ) {
    this.#relative = corpus.relative(source.fileName);
  }

  visit(): void {
    this.visitReferenceDirectives();
    const walk = (node: ts.Node): void => {
      this.visitNode(node);
      ts.forEachChild(node, walk);
    };
    walk(this.source);
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
    } else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
      this.heritageEdges(node);
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
    const symbol = this.corpus.checker.getSymbolAtLocation(specifier);
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
      const kind: EdgeKind =
        clause.token === ts.SyntaxKind.ImplementsKeyword ? "interfaceImplementation" : "inheritance";
      for (const type of clause.types) {
        const to = this.typeTarget(type.expression);
        if (to === undefined) continue;
        this.push({ kind, from, to, provenance: "declared", anchor: this.anchorOf(type) });
      }
    }
  }

  /** What a written type expression names: a keyed type, an `<unresolved>` stub, or nothing (counted). */
  typeTarget(expression: ts.Expression): Key | undefined {
    const symbol = this.corpus.checker.getSymbolAtLocation(expression);
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

  // ------------------------------------------------------------- helpers ----

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

/** `import("x")`, or a bare `require("x")` call. */
function isImportCall(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1;
}
