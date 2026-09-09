import ts from "typescript";
import { loadCorpus, type Corpus } from "./corpus.js";
import { extractEdges } from "./edges.js";
import { extractEntities } from "./entities.js";
import { Ids } from "./ids.js";
import { keyIndex, LANG, renderKey } from "./model/keys.js";
import type { Entity, Model, Repository } from "./model/model.js";
import type { Progress } from "./progress.js";
import { ResolutionStats } from "./stats.js";
import { Stubs } from "./stubs.js";

export interface ExtractOptions {
  readonly sources: readonly string[];
  readonly cwd: string;
  readonly repository: Repository | undefined;
  readonly tsconfig: string | undefined;
  readonly allowJs: boolean;
  readonly ignoreNodeModules: boolean;
}

export interface Extraction {
  readonly model: Model;
  readonly stats: ResolutionStats;
  readonly stubs: number;
  readonly corpus: Corpus;
}

export const EXTRACTOR_NAME = "codegraph-typescript";

/** The four passes, each a phase on stderr. */
export function extract(options: ExtractOptions, progress: Progress, version: string): Extraction {
  const stats = new ResolutionStats();
  const corpus = progress.phase(
    "program",
    () =>
      loadCorpus({
        sources: options.sources,
        cwd: options.cwd,
        tsconfig: options.tsconfig,
        allowJs: options.allowJs,
        ignoreNodeModules: options.ignoreNodeModules,
      }),
    (c) => `${c.files.length} files, tsconfig ${c.configPath ?? "none"}`,
  );
  const stubs = new Stubs();
  const ids = new Ids(corpus, stubs);

  const table = progress.phase("entities", () => extractEntities(corpus, ids, stats), (t) => `${t.values().length} entities`);
  const edges = progress.phase("edges", () => extractEdges(corpus, ids, stubs, table, stats), (e) => `${e.length} edges`);
  const stubEntities = progress.phase("stubs", () => stubs.emit(table.keys(), stats), (s) => `${s.length} stubs`);

  const entities: Entity[] = [...table.values(), ...stubEntities];
  // Closure is a property of the ENCODING (a reference is a surrogate), so an
  // edge the model cannot close is unwritable: a producer drops it and says
  // so, never aborts (schemas/README.md §5). Zero on every audited corpus is
  // the goal; a non-zero count names an id-scheme gap on stderr.
  const declared = new Set(entities.map((entity) => keyIndex(entity.key)));
  const closed = edges.filter((edge) => {
    const ok = declared.has(keyIndex(edge.from)) && declared.has(keyIndex(edge.to));
    if (!ok) stats.unclosableEdgesDropped.push(`${edge.kind} ${renderKey(edge.from)} -> ${renderKey(edge.to)}`);
    return ok;
  });
  const model: Model = {
    lang: LANG,
    extractor: { name: EXTRACTOR_NAME, version, typescript: ts.version },
    root: corpus.rootDisplay,
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    entities,
    edges: closed,
  };
  return { model, stats, stubs: stubEntities.length, corpus };
}
