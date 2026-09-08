import ts from "typescript";
import { loadCorpus, type Corpus } from "./corpus.js";
import { extractEdges } from "./edges.js";
import { extractEntities } from "./entities.js";
import { Ids } from "./ids.js";
import { LANG } from "./model/keys.js";
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
  const edges = progress.phase("edges", () => extractEdges(corpus, ids, stubs, stats), (e) => `${e.length} edges`);
  const stubEntities = progress.phase("stubs", () => stubs.emit(table.keys(), stats), (s) => `${s.length} stubs`);

  const entities: Entity[] = [...table.values(), ...stubEntities];
  const model: Model = {
    lang: LANG,
    extractor: { name: EXTRACTOR_NAME, version, typescript: ts.version },
    root: corpus.rootDisplay,
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    entities,
    edges,
  };
  return { model, stats, stubs: stubEntities.length, corpus };
}
