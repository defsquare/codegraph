import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * WHAT LIVES UNDER `--data-dir` (PLAN §15.2): the OS app-data directory the
 * shell passes, or the platform default for a checkout's dev loop.
 *
 *   <data-dir>/recent.json                    the last projects, newest first
 *   <data-dir>/models/<name>-<hash>/          one directory per opened folder
 *       model.jsonl                           what the extractor wrote
 *       model.db                              the M7 cache, built beside it by openCache
 *       navigator.json, city.json             the page's artifacts, as served
 *       project.json                          what was extracted from, and when
 *
 * A folder is keyed by a hash of its absolute path with the basename in front
 * for a human reading the directory; two folders named `src` never collide.
 */
export const RECENT_KIND = "codegraph.recent/1";
export const PROJECT_KIND = "codegraph.project/1";

/** How many projects the recents list keeps. */
export const RECENT_LIMIT = 20;

/** The platform's per-user application data directory, `/codegraph` under it. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "codegraph");
  if (platform === "win32") return join(env["APPDATA"] ?? join(home, "AppData", "Roaming"), "codegraph");
  return join(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "codegraph");
}

export interface RecentEntry {
  /** The folder (or model.jsonl) as opened — absolute. */
  readonly src: string;
  readonly name: string;
  /** The registry entry that extracted it; null for a model opened directly. */
  readonly extractor: string | null;
  /** ISO time of the last successful open. */
  readonly openedAt: string;
  readonly nodes: number;
  readonly deps: number;
}

export interface RecentFile {
  readonly kind: typeof RECENT_KIND;
  readonly projects: readonly RecentEntry[];
}

export interface ProjectRecord {
  readonly kind: typeof PROJECT_KIND;
  readonly src: string;
  readonly name: string;
  readonly extractor: string | null;
  /** The model the artifacts were built from — under the project directory, or the opened file itself. */
  readonly model: string;
  /** The tree fingerprint the model was extracted from; null for a model opened directly. */
  readonly fingerprint: string | null;
  readonly extractedAt: string | null;
  /** Hash of the build flags + CLI version the artifacts on disk were made with. */
  readonly buildKey: string;
  readonly builtAt: string;
  readonly nodes: number;
  readonly deps: number;
  readonly buildings: number;
}

function safeName(src: string): string {
  const raw = basename(src).replace(/\.jsonl$/i, "");
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  return cleaned.length === 0 ? "project" : cleaned;
}

export function projectDirFor(dataDir: string, src: string): string {
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
  return join(dataDir, "models", `${safeName(src)}-${hash}`);
}

/** Write atomically: a crash mid-write must not leave a half JSON the next start refuses. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // a corrupt cache file is a missing one
  }
}

export function readProject(projectDir: string): ProjectRecord | undefined {
  const parsed = readJson(join(projectDir, "project.json"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return (parsed as { kind?: unknown }).kind === PROJECT_KIND ? (parsed as ProjectRecord) : undefined;
}

export function writeProject(projectDir: string, record: ProjectRecord): void {
  writeJsonAtomic(join(projectDir, "project.json"), record);
}

export function readRecent(dataDir: string): RecentFile {
  const parsed = readJson(join(dataDir, "recent.json"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === RECENT_KIND &&
    Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    return parsed as RecentFile;
  }
  return { kind: RECENT_KIND, projects: [] };
}

/** Put `entry` first, drop an older entry for the same src, cap the list. */
export function pushRecent(dataDir: string, entry: RecentEntry): RecentFile {
  const current = readRecent(dataDir);
  const projects = [entry, ...current.projects.filter((candidate) => candidate.src !== entry.src)].slice(
    0,
    RECENT_LIMIT,
  );
  const next: RecentFile = { kind: RECENT_KIND, projects };
  writeJsonAtomic(join(dataDir, "recent.json"), next);
  return next;
}

/** One key for "the same page would come out": the build flags and the version that interprets them. */
export function buildKeyOf(build: unknown, version: string): string {
  return createHash("sha256").update(JSON.stringify(build)).update("\0").update(version).digest("hex").slice(0, 16);
}
