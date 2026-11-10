import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_PATH_VARIABLE,
  claudeExecutableNames,
  findClaudeCode,
  knownClaudeCodePaths,
  pathDirectories,
} from "../src/claude-code-discovery.js";

/** A fake disk: only the listed paths exist. */
function disk(...paths: readonly string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path) => present.has(path);
}

const HOME = "/home/me";
const ON_PATH = "/usr/local/bin/claude";
const NATIVE = `${HOME}/.local/bin/claude`;
const posixEnv = { HOME, PATH: "/usr/local/bin:/usr/bin" };

describe("findClaudeCode — the search order", () => {
  it("takes the explicit path first, then the variable, then PATH, then the known locations", () => {
    const exists = disk("/opt/mine/claude", "/opt/env/claude", ON_PATH, NATIVE);
    const env = { ...posixEnv, [CLAUDE_CODE_PATH_VARIABLE]: "/opt/env/claude" };
    expect(findClaudeCode({ explicit: "/opt/mine/claude", env, exists, platform: "linux" })).toEqual({
      location: { path: "/opt/mine/claude", source: "option" },
      reason: "--claude-path",
    });
    expect(findClaudeCode({ env, exists, platform: "linux" })).toEqual({
      location: { path: "/opt/env/claude", source: "env" },
      reason: CLAUDE_CODE_PATH_VARIABLE,
    });
    expect(findClaudeCode({ env: posixEnv, exists, platform: "linux" })).toEqual({
      location: { path: ON_PATH, source: "PATH" },
      reason: "found on PATH",
    });
    expect(findClaudeCode({ env: { HOME }, exists, platform: "linux" })).toEqual({
      location: { path: NATIVE, source: "known" },
      reason: "found in a known install location",
    });
  });

  it("an explicit path that does not exist is the answer, with that path in the reason — never a fall-through", () => {
    const exists = disk(ON_PATH, NATIVE);
    const option = findClaudeCode({ explicit: "/nowhere/claude", env: posixEnv, exists, platform: "linux" });
    expect(option.location).toBeUndefined();
    expect(option.reason).toContain("/nowhere/claude");
    expect(option.reason).toContain("--claude-path");
    const variable = findClaudeCode({ env: { ...posixEnv, [CLAUDE_CODE_PATH_VARIABLE]: "/gone/claude" }, exists, platform: "linux" });
    expect(variable.location).toBeUndefined();
    expect(variable.reason).toContain("/gone/claude");
    expect(variable.reason).toContain(CLAUDE_CODE_PATH_VARIABLE);
  });

  it("says what was searched when nothing is found", () => {
    const nothing = findClaudeCode({ env: posixEnv, exists: () => false, platform: "linux" });
    expect(nothing.location).toBeUndefined();
    expect(nothing.reason).toMatch(/PATH/u);
    expect(nothing.reason).toMatch(/known install location/u);
  });

  it("ignores blank values: a blank option or variable falls through, an empty PATH entry is skipped", () => {
    const exists = disk(ON_PATH, "claude");
    expect(findClaudeCode({ explicit: "   ", env: { ...posixEnv, [CLAUDE_CODE_PATH_VARIABLE]: "" }, exists, platform: "linux" })).toMatchObject({
      location: { path: ON_PATH, source: "PATH" },
    });
    expect(pathDirectories({ PATH: ":/usr/bin::/opt/bin: " }, "linux")).toEqual(["/usr/bin", "/opt/bin"]);
    // An empty PATH entry is not the current directory: a bare `claude` there is never tried.
    expect(findClaudeCode({ env: { PATH: "::" }, exists: disk("claude", "/claude"), platform: "linux" }).location).toBeUndefined();
  });
});

describe("findClaudeCode — the platforms' path shapes", () => {
  it("walks PATH with ':' on posix and ';' on win32, reading the Path key of a Windows record", () => {
    expect(pathDirectories({ PATH: "/a:/b" }, "linux")).toEqual(["/a", "/b"]);
    expect(pathDirectories({ PATH: "/a:/b" }, "darwin")).toEqual(["/a", "/b"]);
    expect(pathDirectories({ Path: "C:\\tools;D:\\bin" }, "win32")).toEqual(["C:\\tools", "D:\\bin"]);
    expect(pathDirectories({ PATH: "C:\\tools;D:\\bin" }, "win32")).toEqual(["C:\\tools", "D:\\bin"]);
    expect(pathDirectories({}, "linux")).toEqual([]);
  });

  it("tries claude.exe and claude.cmd on Windows, claude alone elsewhere, in the shell's order", () => {
    expect(claudeExecutableNames("win32")).toEqual(["claude.exe", "claude.cmd", "claude"]);
    expect(claudeExecutableNames("linux")).toEqual(["claude"]);
    expect(claudeExecutableNames("darwin")).toEqual(["claude"]);
    const exists = disk("D:\\bin\\claude.cmd");
    expect(findClaudeCode({ env: { Path: "C:\\tools;D:\\bin" }, exists, platform: "win32" })).toEqual({
      location: { path: "D:\\bin\\claude.cmd", source: "PATH" },
      reason: "found on PATH",
    });
    expect(findClaudeCode({ env: { PATH: "/usr/bin:/opt/bin" }, exists: disk("/opt/bin/claude"), platform: "darwin" }).location).toEqual({
      path: "/opt/bin/claude",
      source: "PATH",
    });
  });

  it("names the install locations per platform, from HOME on posix and USERPROFILE and APPDATA on Windows", () => {
    expect(knownClaudeCodePaths({ HOME }, "linux")).toEqual([
      `${HOME}/.local/bin/claude`,
      `${HOME}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(knownClaudeCodePaths({ HOME }, "darwin")).toEqual(knownClaudeCodePaths({ HOME }, "linux"));
    expect(knownClaudeCodePaths({}, "linux")).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
    expect(knownClaudeCodePaths({ USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toEqual([
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
    expect(knownClaudeCodePaths({ HOME, USERPROFILE: " " }, "win32")).toEqual([]);
    const found = findClaudeCode({ env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, exists: disk("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"), platform: "win32" });
    expect(found).toEqual({
      location: { path: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", source: "known" },
      reason: "found in a known install location",
    });
  });
});
