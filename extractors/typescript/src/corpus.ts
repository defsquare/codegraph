import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { absolute, commonRoot, display, isUnder, relativeOrOutside, relativeTo, slashes } from "./paths.js";

/**
 * Pass 0 — the checker without a build (PLAN.md §14, principle 1). Walk the
 * roots in ordinal order, read a `tsconfig.json` for its RESOLUTION options
 * only, and create ONE program over every source file. Nothing is built,
 * `node_modules` is never required, and a package that resolves to nothing is
 * a stub — the caller's business, decided from what this pass reports.
 */

export interface CorpusOptions {
  /** Source roots as typed on the command line. */
  readonly sources: readonly string[];
  readonly cwd: string;
  /** A tsconfig path, `"none"` for the synthesized defaults, `undefined` to search. */
  readonly tsconfig: string | undefined;
  readonly allowJs: boolean;
  readonly ignoreNodeModules: boolean;
}

export interface WorkspacePackage {
  readonly name: string;
  /** Absolute, `/`-separated. */
  readonly dir: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface Corpus {
  /** Absolute common ancestor of the roots; every anchor is relative to it. */
  readonly root: string;
  /** What the header's `root` shows: the typed path, `/`-separated. */
  readonly rootDisplay: string;
  /** Absolute corpus files, sorted by root-relative path (code-unit order). */
  readonly files: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly configPath: string | undefined;
  /** tsconfig.json files found under other roots and NOT applied. */
  readonly configConflicts: readonly string[];
  readonly packages: readonly WorkspacePackage[];
  /** `containingFile|specifier` pairs the workspace fallback resolved. */
  readonly workspaceResolutions: ReadonlySet<string>;
  isCorpusFile(fileName: string): boolean;
  relative(fileName: string): string;
  /** Root-relative even outside the roots (`../shared/x.ts`). */
  relativeOrOutside(fileName: string): string;
  /** Standard resolution from a file, for specifiers the checker did not bind. */
  resolveSpecifier(specifier: string, containingFile: string): string | undefined;
}

/** Build output and dependencies are never sources. `dist` is what tsup and tsc write. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"] as const;

/** The compiler options a tsconfig may contribute: resolution, never the corpus. */
const RESOLUTION_KEYS = [
  "paths",
  "pathsBasePath",
  "baseUrl",
  "rootDirs",
  "jsx",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "lib",
  "target",
  "allowJs",
  "experimentalDecorators",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "customConditions",
  "resolveJsonModule",
  "allowImportingTsExtensions",
  "allowArbitraryExtensions",
  "moduleSuffixes",
  "typeRoots",
  "types",
  "useDefineForClassFields",
] as const;

export function loadCorpus(options: CorpusOptions): Corpus {
  const rootsFull = options.sources.map((source) => absolute(source, options.cwd));
  for (const root of rootsFull) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`source root is not a directory: ${root}`);
    }
  }
  const root = commonRoot(rootsFull);
  const rootDisplay =
    options.sources.length === 1
      ? display(options.sources[0] as string)
      : display(relativeOrOutside(slashes(options.cwd), root) || ".");

  const walked = walk(rootsFull, options.allowJs);
  const files = walked.files.sort((a, b) => {
    const ra = relativeTo(root, a);
    const rb = relativeTo(root, b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  const fileSet = new Set(files);

  const config = loadConfig(options, rootsFull);
  const compilerOptions = compilerOptionsFor(options, config.options);

  const base = ts.createCompilerHost(compilerOptions, true);
  const libDir = slashes(base.getDefaultLibLocation?.() ?? dirname(ts.getDefaultLibFilePath(compilerOptions)));
  const hidden = (path: string): boolean =>
    options.ignoreNodeModules && /(^|\/)node_modules\//.test(slashes(path)) && !slashes(path).startsWith(libDir);

  const packages = walked.packages;
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const workspaceResolutions = new Set<string>();

  const host: ts.CompilerHost = {
    ...base,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (fileName) => fileName,
    fileExists: (fileName) => !hidden(fileName) && base.fileExists(fileName),
    readFile: (fileName) => (hidden(fileName) ? undefined : base.readFile(fileName)),
    directoryExists: (directory) =>
      !hidden(`${directory}/`) && (base.directoryExists?.(directory) ?? ts.sys.directoryExists(directory)),
    getDirectories: (directory) =>
      hidden(`${directory}/`) ? [] : (base.getDirectories?.(directory) ?? ts.sys.getDirectories(directory)),
  };
  const cache = ts.createModuleResolutionCache(options.cwd, (name) => name, compilerOptions);
  const resolveOne = (specifier: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations => {
    const standard = ts.resolveModuleName(specifier, containingFile, compilerOptions, host, cache);
    if (standard.resolvedModule !== undefined) return standard;
    const fallback = resolveWorkspace(specifier, packageByName, fileSet);
    if (fallback === undefined) return standard;
    workspaceResolutions.add(`${containingFile}|${specifier}`);
    return {
      resolvedModule: {
        resolvedFileName: fallback,
        extension: extensionOf(fallback),
        isExternalLibraryImport: false,
      },
    };
  };
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => resolveOne(literal.text, containingFile));

  const program = ts.createProgram({ rootNames: files, options: compilerOptions, host });

  return {
    root,
    rootDisplay,
    files,
    program,
    checker: program.getTypeChecker(),
    configPath: config.path,
    configConflicts: config.conflicts,
    packages,
    workspaceResolutions,
    isCorpusFile: (fileName) => fileSet.has(slashes(fileName)),
    relative: (fileName) => relativeTo(root, slashes(fileName)),
    relativeOrOutside: (fileName) => relativeOrOutside(root, slashes(fileName)),
    resolveSpecifier: (specifier, containingFile) =>
      resolveOne(specifier, containingFile).resolvedModule?.resolvedFileName,
  };
}

// ------------------------------------------------------------------ walk ----

interface Walked {
  readonly files: string[];
  readonly packages: WorkspacePackage[];
}

function walk(roots: readonly string[], allowJs: boolean): Walked {
  const extensions: readonly string[] = allowJs ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS;
  const files = new Set<string>();
  const packages = new Map<string, WorkspacePackage>();

  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile()) {
        if (entry.name === "package.json") {
          const pkg = readPackage(path, directory);
          // First in ordinal order wins; a second package of one name is a corpus oddity, not a choice.
          if (pkg !== undefined && !packages.has(pkg.name)) packages.set(pkg.name, pkg);
        } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
          files.add(path);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return { files: [...files], packages: [...packages.values()] };
}

function readPackage(path: string, directory: string): WorkspacePackage | undefined {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof json["name"] !== "string" || json["name"] === "") return undefined;
    const fields: Record<string, string> = {};
    for (const field of ["source", "types", "typings", "module", "main"]) {
      if (typeof json[field] === "string") fields[field] = json[field] as string;
    }
    return { name: json["name"], dir: directory, fields };
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------- workspace fallback ----

/**
 * A bare specifier naming a package declared under the roots resolves to that
 * package's SOURCE entry — the monorepo's own packages are corpus, not
 * dependencies (PLAN.md §14.4). Bounded: only after standard resolution failed,
 * only to a file the walk collected, never through `node_modules` or `dist`.
 */
function resolveWorkspace(
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
  corpus: ReadonlySet<string>,
): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < nameLength) return undefined;
  const name = parts.slice(0, nameLength).join("/");
  const subpath = parts.slice(nameLength).join("/");
  const pkg = packages.get(name);
  if (pkg === undefined) return undefined;

  const candidates: string[] = [];
  if (subpath === "") {
    for (const field of ["source", "types", "typings", "module", "main"]) {
      const value = pkg.fields[field];
      if (value !== undefined) candidates.push(...sourceVariants(join(pkg.dir, value)));
    }
    for (const entry of ["src/index.ts", "src/index.tsx", "src/index.mts", "index.ts", "index.tsx", "src/index.d.ts", "index.d.ts"]) {
      candidates.push(join(pkg.dir, entry));
    }
  } else {
    for (const base of [join(pkg.dir, "src", subpath), join(pkg.dir, subpath)]) {
      candidates.push(...sourceVariants(base), `${base}/index.ts`, `${base}/index.tsx`);
    }
  }
  return candidates.map(slashes).find((candidate) => corpus.has(candidate) && isUnder(candidate, pkg.dir));
}

function sourceVariants(path: string): string[] {
  return [
    path,
    path.replace(/\.(m|c)?js$/, ".$1ts"),
    path.replace(/\.js$/, ".tsx"),
    path.replace(/\.js$/, ".d.ts"),
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.d.ts`,
  ];
}

function extensionOf(path: string): ts.Extension {
  for (const extension of [".d.ts", ".tsx", ".mts", ".cts", ".ts", ".jsx", ".mjs", ".cjs", ".js"]) {
    if (path.endsWith(extension)) return extension as ts.Extension;
  }
  return ts.Extension.Ts;
}

// ---------------------------------------------------------------- config ----

interface LoadedConfig {
  readonly path: string | undefined;
  readonly conflicts: readonly string[];
  readonly options: ts.CompilerOptions;
}

function loadConfig(options: CorpusOptions, roots: readonly string[]): LoadedConfig {
  if (options.tsconfig === "none") return { path: undefined, conflicts: [], options: {} };
  let path: string | undefined;
  const conflicts: string[] = [];
  if (options.tsconfig !== undefined) {
    path = absolute(options.tsconfig, options.cwd);
    if (!existsSync(path)) throw new Error(`--tsconfig: no such file: ${path}`);
  } else {
    for (const root of roots) {
      const found = ts.findConfigFile(root, ts.sys.fileExists);
      if (found === undefined) continue;
      const full = slashes(found);
      if (path === undefined) path = full;
      else if (full !== path && !conflicts.includes(full)) conflicts.push(full);
    }
  }
  if (path === undefined) return { path, conflicts, options: {} };

  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error !== undefined || read.config === undefined) {
    throw new Error(`cannot read ${path}: ${ts.flattenDiagnosticMessageText(read.error?.messageText ?? "", "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
  return { path, conflicts, options: parsed.options };
}

/**
 * Synthesized defaults, overlaid with the tsconfig's resolution options. The
 * `module`/`moduleResolution` pair is taken from the config only when the
 * config decides both: a lone `module: commonjs` beside the default `bundler`
 * resolution is an option error, not a corpus fact.
 */
function compilerOptionsFor(options: CorpusOptions, config: ts.CompilerOptions): ts.CompilerOptions {
  const merged: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: options.allowJs,
    checkJs: false,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: false,
    noResolve: false,
  };
  for (const key of RESOLUTION_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  if (config.moduleResolution !== undefined) {
    merged.moduleResolution = config.moduleResolution;
    if (config.module !== undefined) merged.module = config.module;
  }
  if (options.allowJs) merged.allowJs = true;
  if (options.ignoreNodeModules) merged.types = [];
  return merged;
}
