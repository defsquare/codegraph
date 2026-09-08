import { keyIndex, moduleKey, unescape, type Key } from "./model/keys.js";
import type { Entity, Kind, Space } from "./model/model.js";
import type { ResolutionStats } from "./stats.js";

export type StubOrigin = "lib" | "package" | "unresolved" | "outside" | "specifier";

interface ModuleStub {
  readonly module: string;
  readonly name: string;
  readonly origin: StubOrigin;
}

interface TypeStub {
  readonly key: Key;
  readonly kind: Kind;
  readonly name: string;
  readonly space: Space[] | undefined;
}

/**
 * Pass 4 — the stub discipline (PLAN.md §14.4). Everything an edge or a
 * `parent` points at that the corpus does not declare is registered here as
 * it is met, and emitted at the end as a degraded entity: a type carries only
 * `TNamed + TType + TChildOf` (its module), a module `definedIn: []`. Never
 * decided by a path prefix; the corpus file set is the whitelist.
 */
export class Stubs {
  readonly #modules = new Map<string, ModuleStub>();
  readonly #types = new Map<string, TypeStub>();

  noteModule(module: string, name: string, origin: StubOrigin): void {
    if (!this.#modules.has(module)) this.#modules.set(module, { module, name, origin });
  }

  noteType(key: Key, kind: Kind, name: string, space: Space[] | undefined): void {
    const at = keyIndex(key);
    if (!this.#types.has(at)) this.#types.set(at, { key, kind, name, space });
    // A stub type's parent is its stub module; make sure one exists.
    if (!this.#modules.has(key.module)) {
      this.#modules.set(key.module, { module: key.module, name: unescape(key.module), origin: "package" });
    }
  }

  /** Stub entities for every registered key the corpus did not declare. */
  emit(declared: ReadonlySet<string>, stats: ResolutionStats): Entity[] {
    const out: Entity[] = [];
    for (const stub of this.#modules.values()) {
      const key = moduleKey(stub.module);
      if (declared.has(keyIndex(key))) continue;
      out.push({
        key,
        kind: "module",
        traits: ["TNamed", "TModule", "TWithChildren"],
        name: stub.name,
        isStub: true,
        definedIn: [],
      });
      stats.stubs.modules += 1;
    }
    for (const stub of this.#types.values()) {
      if (declared.has(keyIndex(stub.key))) continue;
      const entity: Entity = {
        key: stub.key,
        kind: stub.kind,
        traits: ["TNamed", "TType", "TChildOf"],
        name: stub.name,
        isStub: true,
        parent: moduleKey(stub.key.module),
      };
      if (stub.space !== undefined) entity.space = stub.space;
      out.push(entity);
      const origin = this.#modules.get(stub.key.module)?.origin;
      if (origin === "lib") stats.stubs.lib += 1;
      else if (origin === "unresolved") stats.stubs.unresolved += 1;
      else stats.stubs.packages += 1;
    }
    return out;
  }
}
