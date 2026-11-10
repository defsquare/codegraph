import { posix, win32 } from "node:path";

/**
 * WHERE THE CLAUDE CODE BINARY IS, decided as a pure function of what the
 * caller hands over — an explicit path, the environment, an `exists` probe,
 * the platform — so `--dry-run` resolves a provider without spawning and a
 * test plants a binary on a fake disk. The search order, first hit wins:
 *
 *   1. the explicit path (`--claude-path`)
 *   2. `CLAUDE_CODE_PATH`
 *   3. `claude` in each directory of `PATH` (`claude.exe`, `claude.cmd` too on Windows)
 *   4. the install locations the docs name (native installer, legacy local
 *      install, Homebrew, npm global on Windows)
 *
 * An explicit path that does not exist is an answer, not a fall-through:
 * a user who named a binary gets that path back in the reason, never a
 * different binary found elsewhere.
 */

export const CLAUDE_CODE_PATH_VARIABLE = "CLAUDE_CODE_PATH";

export type ClaudeCodeSource = "option" | "env" | "PATH" | "known";

export interface ClaudeCodeLocation {
  readonly path: string;
  readonly source: ClaudeCodeSource;
}

export interface ClaudeCodeSearch {
  /** `--claude-path`, when given. */
  readonly explicit?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  /** Defaults to this process's platform; tests pass both. */
  readonly platform?: NodeJS.Platform;
}

export interface ClaudeCodeDiscovery {
  readonly location: ClaudeCodeLocation | undefined;
  /**
   * Found: how (`found on PATH`, `--claude-path`, `CLAUDE_CODE_PATH`, `found in a known install location`).
   * Not found: why — the explicit path that does not exist, or what was searched.
   */
  readonly reason: string;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** The executable names `claude` may have on this platform, in the order the shell tries them. */
export function claudeExecutableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
}

/** The directories of `PATH` (`Path` on a Windows record), in order, empty entries dropped. */
export function pathDirectories(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): readonly string[] {
  const raw = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
}

/** The install locations the docs name, for this platform — those whose base (home, APPDATA) the environment gives. */
export function knownClaudeCodePaths(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): readonly string[] {
  if (platform === "win32") {
    const home = env["USERPROFILE"];
    const appData = env["APPDATA"];
    return [
      ...(blank(home) ? [] : [win32.join(home!, ".local", "bin", "claude.exe")]),
      ...(blank(appData) ? [] : [win32.join(appData!, "npm", "claude.cmd")]),
    ];
  }
  const home = env["HOME"];
  return [
    ...(blank(home) ? [] : [posix.join(home!, ".local", "bin", "claude"), posix.join(home!, ".claude", "local", "claude")]),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

export function findClaudeCode(search: ClaudeCodeSearch): ClaudeCodeDiscovery {
  const platform = search.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;

  if (!blank(search.explicit)) {
    const explicit = search.explicit!.trim();
    return search.exists(explicit)
      ? { location: { path: explicit, source: "option" }, reason: "--claude-path" }
      : { location: undefined, reason: `--claude-path ${explicit} does not exist` };
  }
  const fromEnv = search.env[CLAUDE_CODE_PATH_VARIABLE];
  if (!blank(fromEnv)) {
    const named = fromEnv!.trim();
    return search.exists(named)
      ? { location: { path: named, source: "env" }, reason: CLAUDE_CODE_PATH_VARIABLE }
      : { location: undefined, reason: `${CLAUDE_CODE_PATH_VARIABLE}=${named} does not exist` };
  }
  for (const dir of pathDirectories(search.env, platform)) {
    for (const name of claudeExecutableNames(platform)) {
      const candidate = path.join(dir, name);
      if (search.exists(candidate)) return { location: { path: candidate, source: "PATH" }, reason: "found on PATH" };
    }
  }
  for (const candidate of knownClaudeCodePaths(search.env, platform)) {
    if (search.exists(candidate)) return { location: { path: candidate, source: "known" }, reason: "found in a known install location" };
  }
  return { location: undefined, reason: "no claude on PATH or in a known install location" };
}
