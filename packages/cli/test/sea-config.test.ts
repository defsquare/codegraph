import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hostRid, seaUnsupported } from "../scripts/sea-build.mjs";
import { filesBelow, repositorySeaConfig, seaConfig, SEA_FUSE } from "../scripts/sea-config.mjs";

/**
 * The image's build inputs (PLAN §15.3) are generated, never hand-written:
 * every frontend file becomes one asset under the prefix `assets.ts` reads,
 * deterministically ordered so two builds list the same blob.
 */
function bundle(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-sea-config-"));
  for (const relative of files) {
    mkdirSync(join(dir, relative, ".."), { recursive: true });
    writeFileSync(join(dir, relative), relative);
  }
  return dir;
}

describe("seaConfig", () => {
  it("lists every frontend file under its prefix, plus package.json, sorted", () => {
    const viz = bundle(["index.html", "assets/index-abc.js", "assets/index-abc.css"]);
    const ui = bundle(["index.html", "assets/index-def.js"]);
    const config = seaConfig({
      main: "/out/codegraph.cjs",
      output: "/out/codegraph.blob",
      packageJson: "/pkg/package.json",
      frontends: { viz, "navigator-ui": ui },
    });
    expect(Object.keys(config.assets)).toEqual([
      "package.json",
      "navigator-ui/assets/index-def.js",
      "navigator-ui/index.html",
      "viz/assets/index-abc.css",
      "viz/assets/index-abc.js",
      "viz/index.html",
    ]);
    expect(config.assets["viz/assets/index-abc.js"]).toBe(resolve(viz, "assets/index-abc.js"));
    expect(config.main).toBe(resolve("/out/codegraph.cjs"));
    expect(config.output).toBe(resolve("/out/codegraph.blob"));
    expect(config.disableExperimentalSEAWarning).toBe(true);
    expect(config.useCodeCache).toBe(true);
  });

  it("walks with forward slashes and sorts, whatever the OS", () => {
    const dir = bundle(["b/y.js", "a.js", "b/x.js"]);
    expect(filesBelow(dir)).toEqual(["a.js", "b/x.js", "b/y.js"]);
  });

  it("describes the repository's own layout: the CLI bundle and both frontends", () => {
    const config = repositorySeaConfig("/tmp/dist-sea");
    expect(config.main).toBe(resolve("/tmp/dist-sea/codegraph.cjs"));
    expect(config.output).toBe(resolve("/tmp/dist-sea/codegraph.blob"));
    expect(config.assets["package.json"]).toMatch(/packages[/\\]cli[/\\]package\.json$/);
    // Built frontends are listed when present; the smoke test on a real image is what proves them.
    for (const key of Object.keys(config.assets)) {
      expect(key === "package.json" || key.startsWith("viz/") || key.startsWith("navigator-ui/")).toBe(true);
    }
  });

  it("names Node's sentinel fuse and the RID vocabulary the other binaries use", () => {
    expect(SEA_FUSE).toBe("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2");
    expect(hostRid("darwin", "arm64")).toBe("osx-arm64");
    expect(hostRid("darwin", "x64")).toBe("osx-x64");
    expect(hostRid("linux", "x64")).toBe("linux-x64");
    expect(hostRid("linux", "arm64")).toBe("linux-arm64");
    expect(hostRid("win32", "x64")).toBe("win-x64");
  });

  it("refuses a Node compiled without single-executable support, naming the way out", () => {
    // Homebrew's node is such a build: `--experimental-sea-config` only prints "disabled".
    const reason = seaUnsupported({ single_executable_application: false }, "/opt/homebrew/bin/node");
    expect(reason).toContain("/opt/homebrew/bin/node");
    expect(reason).toContain("CODEGRAPH_SEA_NODE");
    expect(seaUnsupported({ single_executable_application: true }, "/usr/local/bin/node")).toBeUndefined();
    // Older Nodes do not report the variable at all; absence is not a refusal.
    expect(seaUnsupported({}, "/usr/local/bin/node")).toBeUndefined();
  });
});
