import ts from "typescript";
import type { Corpus } from "./corpus.js";
import {
  bindingRoot,
  boundName,
  declarationName,
  Ids,
  isInvocable,
  isParameterProperty,
  spaceOfTypeKind,
  typeKindOf,
  unwrap,
} from "./ids.js";
import { literalOf, valueOf } from "./literals.js";
import { cyclomatic, sloc } from "./measures.js";
import { disambiguated, keyIndex, renderKey, type Key } from "./model/keys.js";
import type { Anchor, Entity, Kind, Literal, Space, Trait } from "./model/model.js";
import type { ResolutionStats } from "./stats.js";

/**
 * Pass 2 — entities. One record per declaration the profile licenses, with
 * the kind → traits table restated from the profile (`core` re-validates it
 * in the cross-language gate): modules, ambient modules, namespaces, every
 * type kind, members, invocables named and nameless, parameters, locals,
 * and the members of a bound object literal.
 */

/** The kinds declaration merging can combine, strongest first (ids.ts mergeRank, restated on kinds). */
const KIND_MERGE_RANK: ReadonlyMap<Kind, number> = new Map<Kind, number>([
  ["class", 0],
  ["abstractClass", 0],
  ["enum", 1],
  ["function", 2],
  ["variable", 3],
  ["interface", 4],
  ["typeAlias", 5],
  ["namespace", 6],
]);

/** Same-file merging: one key, one entity. A different KIND under one key merges or is re-keyed. */
export class EntityTable {
  readonly #entities = new Map<string, Entity>();

  constructor(private readonly stats: ResolutionStats) {}

  /** Adds, merges, or re-keys; returns the entity that now owns the key. */
  add(entity: Entity, position?: string): Entity {
    const at = keyIndex(entity.key);
    const existing = this.#entities.get(at);
    if (existing === undefined) {
      this.#entities.set(at, entity);
      return entity;
    }
    if (existing.kind === entity.kind) {
      if (entity.kind === "module" && entity.definedIn !== undefined) {
        existing.definedIn = [...new Set([...(existing.definedIn ?? []), ...entity.definedIn])].sort();
      }
      // Overloads, same-file interface merging: one entity, the first anchor.
      if (existing.kind === "function" || existing.kind === "method" || existing.kind === "interface" || existing.kind === "namespace" || existing.kind === "enum") {
        return existing;
      }
      if (position === undefined) return existing;
    } else {
      // Declaration merging across kinds — `class Foo {}` beside `interface Foo
      // {}` or `namespace Foo {}` — is ONE symbol to the checker and one entity
      // here: the strongest kind owns the key (class > enum > function >
      // variable > interface > alias > namespace), whichever was written first;
      // the weaker declaration adds members to it and is no entity of its own.
      const existingRank = KIND_MERGE_RANK.get(existing.kind);
      const entityRank = KIND_MERGE_RANK.get(entity.kind);
      if (existingRank !== undefined && entityRank !== undefined) {
        if (entityRank < existingRank) this.#entities.set(at, entity);
        return this.#entities.get(at) as Entity;
      }
      if (position === undefined) return existing;
    }
    // Not mergeable in the language: two declarations that happen to share a
    // key — the later one carries its position as the disambiguator, and the
    // re-keying is named on stderr.
    const rekeyed: Entity = { ...entity, key: disambiguated(entity.key, position) };
    this.stats.duplicateKeys.push(`${renderKey(entity.key)} -> ${renderKey(rekeyed.key)}`);
    return this.add(rekeyed);
  }

  get(key: Key): Entity | undefined {
    return this.#entities.get(keyIndex(key));
  }

  /** A marker trait an entity earns by what it owns (children, invocations, accesses). */
  mark(key: Key, trait: Trait): void {
    const entity = this.get(key);
    if (entity !== undefined && !entity.traits.includes(trait)) (entity.traits as Trait[]).push(trait);
  }

  keys(): ReadonlySet<string> {
    return new Set(this.#entities.keys());
  }

  values(): Entity[] {
    return [...this.#entities.values()];
  }
}

export function extractEntities(corpus: Corpus, ids: Ids, stats: ResolutionStats): EntityTable {
  const table = new EntityTable(stats);
  for (const file of corpus.files) {
    const source = corpus.program.getSourceFile(file);
    if (source === undefined) throw new Error(`the program lost a corpus file: ${file}`);
    new FileVisitor(corpus, ids, table, stats, source).visitFile();
  }
  return table;
}

const INVOCABLE_TRAITS: readonly Trait[] = [
  "TInvocable",
  "TWithChildren",
  "TWithParameters",
  "TWithLocalVariables",
  "TWithInvocations",
  "TWithAccesses",
  "TChildOf",
  "TSourceAnchor",
];

class FileVisitor {
  readonly #relative: string;

  constructor(
    private readonly corpus: Corpus,
    private readonly ids: Ids,
    private readonly table: EntityTable,
    private readonly stats: ResolutionStats,
    private readonly source: ts.SourceFile,
  ) {
    this.#relative = corpus.relative(source.fileName);
  }

  // ----------------------------------------------------------------- files ----

  visitFile(): void {
    const key = this.ids.moduleOfFile(this.source).key;
    const lineStarts = this.source.getLineStarts();
    const endsWithNewline = this.source.text.endsWith("\n");
    const lastLine = Math.max(1, lineStarts.length - (endsWithNewline ? 1 : 0));
    this.table.add({
      key,
      kind: "module",
      traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor", "TMetrics"],
      name: this.#relative,
      isStub: false,
      definedIn: [this.#relative],
      metrics: { sloc: sloc(this.source, this.source) },
      space: ["value"],
      anchor: { file: this.#relative, span: [1, lastLine] },
    });
    this.visitChildren(this.source);
  }

  /** The generic descent: every node that declares something is an entity; everything else is transparent. */
  visitChildren(node: ts.Node): void {
    ts.forEachChild(node, (child) => this.visitNode(child));
  }

  visitNode(node: ts.Node): void {
    if (ts.isModuleDeclaration(node)) return this.visitModuleDeclaration(node);
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      return this.visitType(node);
    }
    if (ts.isClassExpression(node)) return this.visitClassExpression(node);
    if (ts.isEnumMember(node)) return this.visitEnumMember(node);
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (ts.isMethodSignature(node) && ts.isTypeLiteralNode(node.parent)) return this.visitChildren(node);
      return this.visitNamedInvocable(node);
    }
    if (ts.isConstructorDeclaration(node)) return this.visitConstructor(node);
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return this.visitNamelessInvocable(node);
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (ts.isPropertySignature(node) && ts.isTypeLiteralNode(node.parent)) return this.visitChildren(node);
      if (ts.isObjectLiteralExpression(node.parent) && boundName(node.parent) === undefined) return this.visitChildren(node);
      return this.visitProperty(node);
    }
    if (ts.isVariableDeclaration(node)) return this.visitVariable(node);
    if (ts.isParameter(node)) return this.visitParameter(node);
    if (ts.isBindingElement(node)) return this.visitBindingElement(node);
    this.visitChildren(node);
  }

  // --------------------------------------------------------------- modules ----

  visitModuleDeclaration(node: ts.ModuleDeclaration): void {
    if (node.flags & ts.NodeFlags.GlobalAugmentation) {
      // `declare global { }`: no entity; its members are the file's.
      this.visitBody(node.body);
      return;
    }
    if (ts.isStringLiteral(node.name)) {
      // `declare module "x" { }`: a module the corpus declares.
      const key = this.ids.ambientModuleKey(node.name.text);
      const entity: Entity = {
        key,
        kind: "module",
        traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor", "TMetrics"],
        name: Ids.normalizeSpecifier(node.name.text),
        isStub: false,
        definedIn: [this.#relative],
        metrics: { sloc: sloc(node, this.source) },
        space: ["value"],
        anchor: this.anchorOf(node),
      };
      this.withComments(node, entity);
      this.table.add(entity);
      this.visitBody(node.body);
      return;
    }
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (key === undefined || parent === undefined) return;
    const entity: Entity = {
      key,
      kind: "namespace",
      traits: ["TNamed", "TWithChildren", "TChildOf", "TSourceAnchor", "TMetrics"],
      name: node.name.text,
      parent,
      metrics: { sloc: sloc(node, this.source) },
      space: namespaceSpace(node),
      anchor: this.anchorOf(node),
    };
    // `namespace A.B {}` is two declarations sharing one JSDoc; it belongs to A.
    if (!(node.flags & ts.NodeFlags.NestedNamespace)) this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitBody(node.body);
  }

  visitBody(body: ts.ModuleDeclaration["body"]): void {
    if (body === undefined) return;
    if (ts.isModuleBlock(body)) this.visitChildren(body);
    else if (ts.isModuleDeclaration(body)) this.visitModuleDeclaration(body);
  }

  // ----------------------------------------------------------------- types ----

  visitType(node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration): void {
    const kind = typeKindOf(node);
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    const name = declarationName(node);
    if (kind === undefined || key === undefined || parent === undefined || name === undefined) return;
    const entity: Entity = {
      key,
      kind,
      traits: [...typeTraits(kind), "TMetrics"],
      name,
      isStub: false,
      parent,
      metrics: { sloc: sloc(node, this.source) },
      space: spaceOfTypeKind(kind, node),
      anchor: this.anchorOf(node),
    };
    if (ts.isTypeAliasDeclaration(node)) {
      const aliased = this.typeKeyOfNode(node.type);
      if (aliased !== undefined) {
        entity.declaredType = aliased;
        (entity.traits as Trait[]).push("TTypedEntity");
      }
    }
    this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitChildren(node);
  }

  /** `const A = class {}` is the class A; a class expression with no binding is no entity (counted). */
  visitClassExpression(node: ts.ClassExpression): void {
    const key = this.ids.declarationKey(node);
    const binding = boundName(node);
    if (key === undefined || binding === undefined) {
      this.stats.namelessClassesDropped += 1;
      return;
    }
    const kind = typeKindOf(node) ?? "class";
    const parent = this.ids.ownerKey(binding);
    if (parent === undefined) return;
    const entity: Entity = {
      key,
      kind,
      traits: [...typeTraits(kind), "TMetrics"],
      name: declarationName(binding) ?? "",
      isStub: false,
      parent,
      metrics: { sloc: sloc(node, this.source) },
      space: ["type", "value"],
      anchor: this.anchorOf(node),
    };
    this.withComments(binding.parent?.parent ?? binding, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitChildren(node);
  }

  visitEnumMember(node: ts.EnumMember): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    const name = declarationName(node);
    if (key === undefined || parent === undefined || name === undefined) return;
    const entity: Entity = {
      key,
      kind: "property",
      traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      name,
      parent,
      declaredType: parent,
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    const constant = this.ids.checker.getConstantValue(node);
    let value: Literal | undefined;
    if (typeof constant === "number") value = { k: "number", v: String(constant) };
    else if (typeof constant === "string") value = { k: "string", v: constant };
    else if (node.initializer !== undefined) value = literalOf(node.initializer, this.ids);
    if (value !== undefined) {
      entity.value = value;
      (entity.traits as Trait[]).push("TWithValue");
    }
    this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitChildren(node);
  }

  // ------------------------------------------------------------ invocables ----

  visitNamedInvocable(
    node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  ): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    const name = declarationName(node);
    if (key === undefined || parent === undefined || name === undefined) return;
    // Overloads are one declaration: the implementation (or the sole ambient
    // signature) is the entity; a signature beside a body adds nothing.
    if (this.ids.isOverloadSignature(node)) return;
    const kind: Kind = ts.isFunctionDeclaration(node) ? "function" : "method";
    const entity: Entity = {
      key,
      kind,
      traits: ["TNamed", ...INVOCABLE_TRAITS, "TMetrics"],
      name,
      signature: this.signatureOf(node),
      parent,
      parameters: [],
      localVariables: [],
      metrics: this.invocableMetrics(node),
      // An interface's member exists only for the checker (METAMODEL §1.4).
      space: isInterfaceMember(node) ? ["type"] : ["value"],
      anchor: this.anchorOf(node),
    };
    this.withReturnType(node, entity);
    this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitChildren(node);
  }

  visitConstructor(node: ts.ConstructorDeclaration): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (key === undefined || parent === undefined) return;
    if (this.ids.isOverloadSignature(node)) return;
    const entity: Entity = {
      key,
      kind: "constructor",
      traits: [...INVOCABLE_TRAITS, "TMetrics"],
      signature: this.signatureOf(node),
      parent,
      parameters: [],
      localVariables: [],
      metrics: this.invocableMetrics(node),
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.visitChildren(node);
  }

  visitNamelessInvocable(node: ts.FunctionExpression | ts.ArrowFunction): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (key === undefined || parent === undefined) return;
    const kind: Kind = ts.isArrowFunction(node) ? "arrowFunction" : "function";
    const entity: Entity = {
      key,
      kind,
      traits: [...INVOCABLE_TRAITS, "TMetrics"],
      signature: this.signatureOf(node),
      parent,
      parameters: [],
      localVariables: [],
      metrics: this.invocableMetrics(node),
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    if (ts.isFunctionExpression(node) && node.name !== undefined) {
      entity.name = node.name.text;
      (entity.traits as Trait[]).unshift("TNamed");
    }
    this.withReturnType(node, entity);
    this.table.add(entity);
    this.table.mark(parent, "TWithChildren");
    this.visitChildren(node);
  }

  signatureOf(node: ts.SignatureDeclaration): string {
    const signature = this.ids.checker.getSignatureFromDeclaration(node);
    return signature === undefined ? "()" : this.ids.checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation);
  }

  invocableMetrics(node: ts.SignatureDeclaration): Record<string, number> {
    const body = (node as ts.FunctionLikeDeclaration).body;
    return { sloc: sloc(node, this.source), cyclomatic: body === undefined ? 1 : cyclomatic(body) };
  }

  withReturnType(node: ts.SignatureDeclaration, entity: Entity): void {
    const declared = node.type === undefined ? undefined : this.typeKeyOfNode(node.type);
    if (declared !== undefined) {
      entity.declaredType = declared;
      (entity.traits as Trait[]).push("TTypedEntity");
    }
  }

  // ------------------------------------------------------------ structural ----

  visitProperty(
    node: ts.PropertyDeclaration | ts.PropertySignature | ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  ): void {
    const classInitializer = ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) ? unwrap(node.initializer) : undefined;
    if (classInitializer !== undefined && ts.isClassExpression(classInitializer)) {
      // The property IS the class (ids.ts): visit the expression, no property entity.
      this.visitChildren(node);
      return;
    }
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    const name = declarationName(node);
    if (key === undefined || parent === undefined || name === undefined) {
      this.visitChildren(node);
      return;
    }
    const entity: Entity = {
      key,
      kind: "property",
      traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      name,
      parent,
      space: isInterfaceMember(node) ? ["type"] : ["value"],
      anchor: this.anchorOf(node),
    };
    this.withDeclaredType(node, entity);
    const readonly = ts.isPropertyDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly) !== 0;
    const initializer = ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) ? node.initializer : undefined;
    if (readonly && initializer !== undefined) this.withValue(initializer, entity);
    this.withComments(node, entity);
    this.table.add(entity, this.ids.position(node));
    this.table.mark(parent, "TWithChildren");
    this.visitChildren(node);
  }

  visitVariable(node: ts.VariableDeclaration): void {
    const initializer = unwrap(node.initializer);
    if (initializer !== undefined && ts.isClassExpression(initializer)) {
      // The variable IS the class (ids.ts): visit the expression, no variable entity.
      this.visitChildren(node);
      return;
    }
    if (!ts.isIdentifier(node.name)) {
      // A destructuring pattern: its binding elements are the entities.
      this.visitChildren(node);
      return;
    }
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (key === undefined || parent === undefined) return;
    const entity: Entity = {
      key,
      kind: "variable",
      traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      name: node.name.text,
      parent,
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    this.withDeclaredType(node, entity);
    const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
    if (isConst && node.initializer !== undefined) this.withValue(node.initializer, entity);
    this.withComments(node.parent?.parent ?? node, entity);
    const added = this.table.add(entity, this.ids.position(node.name));
    if (this.ids.isLocal(node)) this.noteLocal(parent, added.key);
    else this.table.mark(parent, "TWithChildren");
    this.visitChildren(node);
  }

  visitParameter(node: ts.ParameterDeclaration): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (key === undefined || parent === undefined || !ts.isIdentifier(node.name)) {
      this.visitChildren(node);
      return;
    }
    const entity: Entity = {
      key,
      kind: "parameter",
      traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      name: node.name.text,
      parent,
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    this.withDeclaredType(node, entity);
    if (node.initializer !== undefined) this.withValue(node.initializer, entity);
    const added = this.table.add(entity, this.ids.position(node.name));
    this.noteParameter(parent, added.key);
    // A parameter property (`constructor(private x: T)`) declares a field too.
    if (ts.isConstructorDeclaration(node.parent) && isParameterProperty(node)) {
      const owner = this.ids.ownerKey(node.parent);
      const propertyKey = this.ids.parameterPropertyKey(node);
      if (owner !== undefined && propertyKey !== undefined) {
        const property: Entity = {
          key: propertyKey,
          kind: "property",
          traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
          name: node.name.text,
          parent: owner,
          space: ["value"],
          anchor: this.anchorOf(node),
        };
        this.withDeclaredType(node, property);
        this.table.add(property, this.ids.position(node.name));
      }
    }
    this.visitChildren(node);
  }

  visitBindingElement(node: ts.BindingElement): void {
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    const root = bindingRoot(node);
    if (key === undefined || parent === undefined || root === undefined || !ts.isIdentifier(node.name)) {
      this.visitChildren(node);
      return;
    }
    const isParameter = ts.isParameter(root);
    const entity: Entity = {
      key,
      kind: isParameter ? "parameter" : "variable",
      traits: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      name: node.name.text,
      parent,
      space: ["value"],
      anchor: this.anchorOf(node),
    };
    this.withDeclaredType(node, entity);
    const added = this.table.add(entity, this.ids.position(node.name));
    if (isParameter) this.noteParameter(parent, added.key);
    else if (this.ids.isLocal(root)) this.noteLocal(parent, added.key);
    else this.table.mark(parent, "TWithChildren");
    this.visitChildren(node);
  }

  noteParameter(owner: Key, key: Key): void {
    const entity = this.table.get(owner);
    if (entity?.parameters !== undefined) entity.parameters.push(key);
  }

  noteLocal(owner: Key, key: Key): void {
    const entity = this.table.get(owner);
    if (entity === undefined) return;
    if (entity.localVariables === undefined) {
      entity.localVariables = [];
      this.table.mark(owner, "TWithLocalVariables");
    }
    entity.localVariables.push(key);
  }

  // --------------------------------------------------------------- helpers ----

  /** The declared type of a value-holding declaration: the one named type it resolves to, else absent. */
  withDeclaredType(node: ts.Node, entity: Entity): void {
    const type = this.ids.checker.getTypeAtLocation(node);
    const key = this.typeKeyOfType(type);
    if (key !== undefined) entity.declaredType = key;
  }

  /** A written type node's key, when it names one declaration. */
  typeKeyOfNode(node: ts.TypeNode): Key | undefined {
    return this.typeKeyOfType(this.ids.checker.getTypeFromTypeNode(node));
  }

  typeKeyOfType(type: ts.Type): Key | undefined {
    let current = type;
    if (this.ids.checker.isArrayType(current)) {
      const element = this.ids.checker.getTypeArguments(current as ts.TypeReference)[0];
      if (element === undefined) return undefined;
      current = element;
    }
    const symbol = current.aliasSymbol ?? current.getSymbol();
    if (symbol === undefined) return undefined;
    if (current.isUnionOrIntersection() && current.aliasSymbol === undefined) return undefined;
    return this.ids.typeKeyOfSymbol(symbol);
  }

  /** A written value when the initializer is constant-shaped; code carries none. */
  withValue(initializer: ts.Expression, entity: Entity): void {
    const value = valueOf(initializer, this.ids);
    if (value === undefined) return;
    entity.value = value;
    (entity.traits as Trait[]).push("TWithValue");
  }

  anchorOf(node: ts.Node): Anchor {
    const start = this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    const end = this.source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { file: this.#relative, span: [start, Math.max(start, end)] };
  }

  /** JSDoc blocks attached to the declaration, comment text only, tags excluded. */
  withComments(node: ts.Node, entity: Entity): void {
    const comments = ts
      .getJSDocCommentsAndTags(node)
      .filter(ts.isJSDoc)
      // Line endings normalised: a CRLF checkout must produce the same bytes.
      .map((doc) => (ts.getTextOfJSDocComment(doc.comment) ?? "").replaceAll("\r\n", "\n").trim())
      .filter((text) => text !== "");
    if (comments.length === 0) return;
    entity.comments = comments;
    (entity.traits as Trait[]).push("TComment");
  }
}

/** Written inside an `interface` body: a member with no runtime existence. */
function isInterfaceMember(node: ts.Node): boolean {
  return node.parent !== undefined && ts.isInterfaceDeclaration(node.parent);
}

function typeTraits(kind: Kind): Trait[] {
  switch (kind) {
    case "class":
    case "abstractClass":
      return ["TNamed", "TType", "TWithInheritances", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"];
    case "interface":
      return ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"];
    case "typeAlias":
      return ["TNamed", "TType", "TChildOf", "TSourceAnchor"];
    case "enum":
      return ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"];
    default:
      throw new Error(`not a type kind: ${kind}`);
  }
}

/** A namespace occupies the value space when this BLOCK declares a value (per declaration, not per merged symbol). */
function namespaceSpace(node: ts.ModuleDeclaration): Space[] {
  return declaresValue(node.body) ? ["type", "value"] : ["type"];
}

function declaresValue(body: ts.ModuleDeclaration["body"]): boolean {
  if (body === undefined) return false;
  if (ts.isModuleDeclaration(body)) return declaresValue(body.body);
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.some((statement) => {
    if (ts.isModuleDeclaration(statement)) return declaresValue(statement.body);
    if (ts.isEnumDeclaration(statement)) return !(ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Const);
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
    if (ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement)) return false;
    return true;
  });
}

export { isInvocable };
