import { basename } from "node:path";
import type { ProgressMode } from "./progress.js";
import type { Repository } from "./model/model.js";

/**
 * The extractor command-line contract (schemas/README.md §8), shared with the
 * Java jar and the C# binary so `codegraph snapshots --extractor` can drive
 * any of them, plus the three TypeScript flags of PLAN.md §14.5.
 */
export interface Options {
  readonly sources: readonly string[];
  readonly out: string;
  readonly progress: ProgressMode;
  readonly repository: Repository | undefined;
  /** A tsconfig path, `"none"` for the synthesized defaults, `undefined` to search. */
  readonly tsconfig: string | undefined;
  readonly allowJs: boolean;
  readonly ignoreNodeModules: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export class UsageError extends Error {
  override name = "UsageError";
}

const HTTPS_REMOTE = /^https:\/\/(?![^\s]*\.git$)[^\s?#]*[^\s?#/]$/;
const SHA = /^[0-9a-f]{7,64}$/;
const RELATIVE_PATH = /^$|^(?!\.\.?(?:\/|$))[^/\s]+(?:\/(?!\.\.?(?:\/|$))[^/\s]+)*$/;

export function parseOptions(args: readonly string[], cwd: string): Options {
  const sources: string[] = [];
  let out: string | undefined;
  let progress: ProgressMode = "auto";
  let remote: string | undefined;
  let commit: string | undefined;
  let root: string | undefined;
  let provider: string | undefined;
  let tsconfig: string | undefined;
  let allowJs = false;
  let ignoreNodeModules = false;
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--src":
        sources.push(value());
        break;
      case "--out":
        out = value();
        break;
      case "--progress": {
        const mode = value();
        if (mode !== "auto" && mode !== "plain" && mode !== "none") {
          throw new UsageError(`--progress must be auto, plain or none, got: ${mode}`);
        }
        progress = mode;
        break;
      }
      case "--no-progress":
        progress = "none";
        break;
      case "--repo-remote":
        remote = value();
        break;
      case "--repo-commit":
        commit = value();
        break;
      case "--repo-root":
        root = value();
        break;
      case "--repo-provider":
        provider = value();
        break;
      case "--tsconfig":
        tsconfig = value();
        break;
      case "--allow-js":
        allowJs = true;
        break;
      case "--ignore-node-modules":
        ignoreNodeModules = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--version":
        version = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  let repository: Repository | undefined;
  if (remote !== undefined || commit !== undefined || root !== undefined || provider !== undefined) {
    if (remote === undefined || commit === undefined || root === undefined) {
      throw new UsageError(
        "--repo-remote, --repo-commit and --repo-root go together (--repo-provider is optional)",
      );
    }
    if (!HTTPS_REMOTE.test(remote)) {
      throw new UsageError(`--repo-remote must be a normalized https URL (no ssh form, no .git): ${remote}`);
    }
    if (!SHA.test(commit)) throw new UsageError(`--repo-commit must be a lowercase hex sha: ${commit}`);
    if (!RELATIVE_PATH.test(root)) {
      throw new UsageError(`--repo-root must be a path relative to the repository root: ${root}`);
    }
    if (provider !== undefined && provider !== "github" && provider !== "gitlab") {
      throw new UsageError(`--repo-provider must be github or gitlab, got: ${provider}`);
    }
    repository = {
      remote,
      commit,
      root,
      ...(provider === undefined ? {} : { provider }),
    };
  }

  if (sources.length === 0) sources.push(".");
  return {
    sources,
    out: out ?? `${basename(cwd)}-codegraph.jsonl`,
    progress,
    repository,
    tsconfig,
    allowJs,
    ignoreNodeModules,
    help,
    version,
  };
}

export function usage(version: string): string {
  return `codegraph-typescript ${version} — TypeScript extractor on the compiler API

USAGE
  codegraph-typescript [--src <dir>…] [--out <file>]

OPTIONS
  --src <dir>           source root to analyze; repeatable. Default: the current
                        directory. With several roots, anchors are relative to
                        their deepest common ancestor, which becomes the model's root.
  --out <file>          where to write the model. Default: <current-dir>-codegraph.jsonl
  --progress <mode>     auto (default: one line per phase on a terminal, nothing
                        when piped), plain, or none
  --no-progress         same as --progress none
  --tsconfig <file>     the tsconfig.json whose RESOLUTION options apply (paths,
                        baseUrl, rootDirs, jsx, lib, target, allowJs); default: the
                        nearest tsconfig.json at or above each root, the first root's
                        winning on conflict; \`none\` for the synthesized defaults
  --allow-js            also walk *.js/*.jsx/*.mjs/*.cjs (JSDoc types feed declaredType)
  --ignore-node-modules never read node_modules, even when present: every external
                        package is an unresolved stub module
  --repo-remote <url>   normalized https clone URL, no .git suffix
  --repo-commit <sha>   the sha this tree is at — a permalink, not a branch
  --repo-root <path>    repo-relative path of the analyzed root ("" at the repo root)
  --repo-provider <p>   github or gitlab, only when the hostname does not say
  --version             print the extractor version
  --help                this text

Nothing is built: every *.ts/*.tsx/*.mts/*.cts under the roots (node_modules, .git
and dist excluded) goes into ONE program; a tsconfig is read for resolution options
only; a package that is not installed is a stub. Exit codes: 0 ok, 1 failure,
2 usage, 3 unimplemented.
`;
}
