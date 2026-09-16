import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { UsageError } from "../exit.js";
import { nodeCommand } from "../sea.js";

/**
 * THE EXTRACTOR REGISTRY — data the shell hands the daemon (PLAN §15.2).
 *
 * Each entry is `{ name, path, extensions[], launch?, env? }`. The daemon knows
 * exactly one thing about an extractor: the §13.5 command line every extractor
 * honours (`<extractor> --src DIR --out FILE`, exit 0/1/2/3, progress on
 * stderr). It never names a language — "there is no `codegraph extract`"
 * (§13.5) holds because a registry entry is run, not a language.
 *
 * DETECTION IS A CENSUS. The tree's file extensions are counted against every
 * entry's `extensions[]`; exactly one claimant is the answer, several is a
 * QUESTION the page asks (never a guess — a Java tree with one `.ts` build
 * script is not a TypeScript project, but only the user knows that), none is
 * a statement about what the tree does hold.
 */
export type Launch = "exec" | "java" | "node";

export interface ExtractorEntry {
  readonly name: string;
  /** The executable, jar or script — resolved by the shell, absolute. */
  readonly path: string;
  /** Lower-case, dotted: `.java`, `.tsx`. */
  readonly extensions: readonly string[];
  readonly launch: Launch;
  /** Extra environment for the process, verbatim — a JAVA_HOME, a DOTNET_ROOT, whatever an entry needs. */
  readonly env: Readonly<Record<string, string>>;
}

export type Registry = readonly ExtractorEntry[];

const LAUNCHES: ReadonlySet<string> = new Set<Launch>(["exec", "java", "node"]);

/** The launch a path implies when the entry does not say — `snapshots --extractor`'s rule. */
function inferLaunch(path: string): Launch {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jar")) return "java";
  if (/\.(m|c)?js$/.test(lower)) return "node";
  return "exec";
}

function normalizeExtension(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

/** Parse and validate a registry file's text; every refusal names the file. */
export function parseRegistry(text: string, label: string): Registry {
  const refuse = (reason: string): never => {
    throw new UsageError(
      `the extractor registry ${label} ${reason}`,
      `Expected a JSON list of { "name", "path", "extensions": [".java"], "launch"?: "exec"|"java"|"node", "env"?: {} }.`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("is not JSON");
  }
  if (!Array.isArray(parsed)) return refuse("is not a list of entries");

  const entries: ExtractorEntry[] = [];
  const names = new Set<string>();
  parsed.forEach((candidate: unknown, index) => {
    if (typeof candidate !== "object" || candidate === null) return refuse(`entry ${index} is not an object`);
    const record = candidate as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.length === 0) return refuse(`entry ${index} has no name`);
    if (names.has(name)) return refuse(`names '${name}' twice`);
    names.add(name);
    const path = record["path"];
    if (typeof path !== "string" || path.length === 0) return refuse(`entry '${name}' has no path`);
    const extensions = record["extensions"];
    if (!Array.isArray(extensions) || extensions.length === 0 || !extensions.every((e) => typeof e === "string")) {
      return refuse(`entry '${name}' claims no extensions`);
    }
    const launch = record["launch"] ?? inferLaunch(path);
    if (typeof launch !== "string" || !LAUNCHES.has(launch)) {
      return refuse(`entry '${name}' has an unknown launch '${String(launch)}'`);
    }
    const env = record["env"] ?? {};
    if (typeof env !== "object" || env === null || Array.isArray(env) || !Object.values(env).every((v) => typeof v === "string")) {
      return refuse(`entry '${name}' has an env that is not a string map`);
    }
    entries.push({
      name,
      path,
      extensions: [...new Set((extensions as string[]).map(normalizeExtension))],
      launch: launch as Launch,
      env: { ...(env as Record<string, string>) },
    });
  });
  return entries;
}

export interface LaunchLine {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The process to spawn for an entry with these extractor arguments. */
export function launchOf(entry: ExtractorEntry, args: readonly string[]): LaunchLine {
  switch (entry.launch) {
    case "java":
      return { command: "java", args: ["-jar", entry.path, ...args], env: entry.env };
    case "node":
      return { command: nodeCommand(), args: [entry.path, ...args], env: entry.env };
    case "exec":
      return { command: entry.path, args: [...args], env: entry.env };
  }
}

export interface CensusFile {
  /** Forward-slash relative path — the same string on every OS, so fingerprints agree. */
  readonly relative: string;
  readonly extension: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface Census {
  /** Every extension seen, claimed or not — what "none" reports. */
  readonly byExtension: ReadonlyMap<string, number>;
  /** Only the files some entry claims — the fingerprint's inputs. */
  readonly files: readonly CensusFile[];
}

/** Directories no extractor reads: VCS metadata, dependency trees, dot-directories. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);

function skipDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

/** Walk `root` once, counting extensions and recording the claimed files. */
export function census(root: string, registry: Registry): Census {
  const claimed = new Set(registry.flatMap((entry) => entry.extensions));
  const byExtension = new Map<string, number>();
  const files: CensusFile[] = [];

  const walk = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return; // unreadable: the extractor will say so if it matters
    }
    for (const name of names) {
      const path = join(directory, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!skipDirectory(name)) walk(path, `${prefix}${name}/`);
        continue;
      }
      if (!stat.isFile()) continue;
      const extension = extname(name).toLowerCase();
      if (extension === "") continue;
      byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
      if (claimed.has(extension)) {
        files.push({ relative: `${prefix}${name}`, extension, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root, "");
  return { byExtension, files };
}

export type Detection =
  | { readonly kind: "one"; readonly entry: ExtractorEntry; readonly files: number }
  | { readonly kind: "ambiguous"; readonly candidates: readonly { readonly name: string; readonly files: number }[] }
  | { readonly kind: "none"; readonly seen: readonly string[] }
  | { readonly kind: "unknown"; readonly name: string };

function claimedFiles(counted: Census, entry: ExtractorEntry): number {
  return entry.extensions.reduce((sum, extension) => sum + (counted.byExtension.get(extension) ?? 0), 0);
}

/**
 * Which entry extracts this tree. `chosen` is the user's answer to an earlier
 * "ambiguous" — it is taken as given, even for a tree that claims none of its
 * files (the extractor will then say so itself).
 */
export function detect(counted: Census, registry: Registry, chosen?: string): Detection {
  if (chosen !== undefined) {
    const entry = registry.find((candidate) => candidate.name === chosen);
    return entry === undefined
      ? { kind: "unknown", name: chosen }
      : { kind: "one", entry, files: claimedFiles(counted, entry) };
  }
  const claimants = registry
    .map((entry) => ({ entry, files: claimedFiles(counted, entry) }))
    .filter((candidate) => candidate.files > 0)
    .sort((a, b) => b.files - a.files || (a.entry.name < b.entry.name ? -1 : 1));
  if (claimants.length === 1) {
    const [only] = claimants;
    return { kind: "one", entry: only!.entry, files: only!.files };
  }
  if (claimants.length === 0) {
    return { kind: "none", seen: [...counted.byExtension.keys()].sort() };
  }
  return { kind: "ambiguous", candidates: claimants.map(({ entry, files }) => ({ name: entry.name, files })) };
}

/**
 * One hash over the files THIS extractor would read — path, size, mtime —
 * so a reopened folder skips extraction when nothing it reads has changed.
 * Content is not hashed: a real corpus is gigabytes, and size-and-mtime is
 * the staleness rule the model.db cache already lives by.
 */
export function treeFingerprint(counted: Census, entry: ExtractorEntry): string {
  const claimed = new Set(entry.extensions);
  const lines = counted.files
    .filter((file) => claimed.has(file.extension))
    .map((file) => `${file.relative}\0${file.size}\0${Math.trunc(file.mtimeMs)}`)
    .sort();
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line).update("\n");
  return hash.digest("hex");
}
