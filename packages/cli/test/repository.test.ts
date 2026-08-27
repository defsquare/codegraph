import { describe, expect, it } from "vitest";
import { Repository } from "@codegraph/core";

import { normalizeRemote, repositoryFacts } from "../src/repository.js";

/**
 * The CLI is the only part of the pipeline that talks to git, so it is the only
 * one that can turn a clone URL into the fact the interchange asks for. What
 * matters here is the pair of duties: normalize every form git actually emits,
 * and refuse — rather than guess — the ones no browser can open.
 */
describe("normalizeRemote", () => {
  const expected = "https://github.com/google/gson";

  it("normalizes every form git hands out for one hosted repository", () => {
    for (const url of [
      "git@github.com:google/gson.git",
      "git@github.com:google/gson",
      "ssh://git@github.com/google/gson.git",
      "ssh://git@github.com:22/google/gson.git",
      "git://github.com/google/gson.git",
      "https://github.com/google/gson.git",
      "https://github.com/google/gson/",
      "https://tokenuser@github.com/google/gson.git",
      "  https://github.com/google/gson  ",
    ]) {
      expect(normalizeRemote(url), url).toBe(expected);
    }
  });

  it("keeps a self-hosted host and a nested group path whole", () => {
    expect(normalizeRemote("git@gitlab.acme.io:platform/tools/codegraph.git")).toBe(
      "https://gitlab.acme.io/platform/tools/codegraph",
    );
  });

  it("says nothing about a remote no browser can open", () => {
    for (const url of [
      "/srv/git/repo.git",
      "../sibling",
      "file:///srv/git/repo.git",
      // http is not silently upgraded: the scheme is a fact about the host.
      "http://github.com/google/gson",
      "",
      "   ",
    ]) {
      expect(normalizeRemote(url), url).toBeUndefined();
    }
  });

  it("only ever produces a value core accepts", () => {
    for (const url of [
      "git@github.com:google/gson.git",
      "ssh://git@gitlab.acme.io:2222/team/app.git",
      "https://github.com/google/gson/",
    ]) {
      const remote = normalizeRemote(url);
      expect(
        Repository.safeParse({ remote, commit: "a".repeat(40), root: "" }).success,
        url,
      ).toBe(true);
    }
  });
});

describe("repositoryFacts", () => {
  const sha = "4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1";

  it("carries the analyzed root, spelled the one way the contract allows", () => {
    for (const root of ["gson/src/main/java", "./gson/src/main/java", "/gson/src/main/java", "gson/src/main/java/"]) {
      expect(repositoryFacts("git@github.com:google/gson.git", sha, root)?.root, root).toBe(
        "gson/src/main/java",
      );
    }
    expect(repositoryFacts("git@github.com:google/gson.git", sha, undefined)?.root).toBe("");
  });

  it("is undefined — not partial — when the remote cannot be projected", () => {
    expect(repositoryFacts("/srv/git/repo.git", sha, "src")).toBeUndefined();
    expect(repositoryFacts(undefined, sha, "src")).toBeUndefined();
  });
});
