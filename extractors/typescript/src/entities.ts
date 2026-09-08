import ts from "typescript";
import type { Corpus } from "./corpus.js";
import { declarationName, Ids, spaceOfTypeKind, typeKindOf } from "./ids.js";
import { disambiguated, keyIndex, renderKey, type Key } from "./model/keys.js";
import type { Anchor, Entity, Kind, Space, Trait } from "./model/model.js";
import type { ResolutionStats } from "./stats.js";

/**
 * Pass 2 — entities. One record per declaration the profile licenses, with
 * the kind → traits table restated from the profile (`core` re-validates it
 * in the cross-language gate). M13a: modules, ambient modules, namespaces and
 * every type kind; members arrive in M13b.
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
  add(entity: Entity): Entity {
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
      return existing;
    }
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
    // Not mergeable in the language: two declarations that happen to share a
    // key — the later one carries its kind as the disambiguator, and the
    // re-keying is named on stderr.
    const rekeyed: Entity = { ...entity, key: disambiguated(entity.key, entity.kind) };
    this.stats.duplicateKeys.push(`${renderKey(entity.key)} -> ${renderKey(rekeyed.key)}`);
    return this.add(rekeyed);
  }

  has(key: Key): boolean {
    return this.#entities.has(keyIndex(key));
  }

  get(key: Key): Entity | undefined {
    return this.#entities.get(keyIndex(key));
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
    new FileVisitor(corpus, ids, table, source).visitFile();
  }
  return table;
}

class FileVisitor {
  readonly #relative: string;

  constructor(
    private readonly corpus: Corpus,
    private readonly ids: Ids,
    private readonly table: EntityTable,
    private readonly source: ts.SourceFile,
  ) {
    this.#relative = corpus.relative(source.fileName);
  }

  visitFile(): void {
    const key = this.ids.moduleOfFile(this.source).key;
    const lineStarts = this.source.getLineStarts();
    const endsWithNewline = this.source.text.endsWith("\n");
    const lastLine = Math.max(1, lineStarts.length - (endsWithNewline ? 1 : 0));
    this.table.add({
      key,
      kind: "module",
      traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"],
      name: this.#relative,
      isStub: false,
      definedIn: [this.#relative],
      space: ["value"],
      anchor: { file: this.#relative, span: [1, lastLine] },
    });
    for (const statement of this.source.statements) this.visitStatement(statement);
  }

  visitStatement(node: ts.Statement): void {
    if (ts.isModuleDeclaration(node)) return this.visitModuleDeclaration(node);
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      this.visitType(node);
    }
  }

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
        traits: ["TNamed", "TModule", "TWithChildren", "TSourceAnchor"],
        name: Ids.normalizeSpecifier(node.name.text),
        isStub: false,
        definedIn: [this.#relative],
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
    const traits: Trait[] = ["TNamed", "TWithChildren", "TChildOf", "TSourceAnchor"];
    const entity: Entity = {
      key,
      kind: "namespace",
      traits,
      name: node.name.text,
      parent,
      space: namespaceSpace(node),
      anchor: this.anchorOf(node),
    };
    // `namespace A.B {}` is two declarations sharing one JSDoc; it belongs to A.
    if (!(node.flags & ts.NodeFlags.NestedNamespace)) this.withComments(node, entity);
    this.table.add(entity);
    this.visitBody(node.body);
  }

  visitBody(body: ts.ModuleDeclaration["body"]): void {
    if (body === undefined) return;
    if (ts.isModuleBlock(body)) {
      for (const statement of body.statements) this.visitStatement(statement);
    } else if (ts.isModuleDeclaration(body)) {
      this.visitModuleDeclaration(body);
    }
  }

  visitType(
    node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  ): void {
    const kind = typeKindOf(node);
    const key = this.ids.declarationKey(node);
    const parent = this.ids.ownerKey(node);
    if (kind === undefined || key === undefined || parent === undefined) return;
    const name = declarationName(node);
    if (name === undefined) return;
    const entity: Entity = {
      key,
      kind,
      traits: typeTraits(kind),
      name,
      isStub: false,
      parent,
      space: spaceOfTypeKind(kind, node),
      anchor: this.anchorOf(node),
    };
    this.withComments(node, entity);
    this.table.add(entity);
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
