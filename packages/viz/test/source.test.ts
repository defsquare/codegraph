import { describe, expect, it } from "vitest";

import { sourceUrl, type RepositoryFacts } from "../src/scene/source.js";

/**
 * The permalink projection (METAMODEL §9): the artifact carries FACTS, the
 * renderer builds the URL. Every case here is about not producing a link that
 * lies — a wrong host template, a lost root prefix, a moved branch, or a link
 * offered for a building the model never anchored.
 */
const gson: RepositoryFacts = {
  remote: "https://github.com/google/gson",
  commit: "4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1",
  root: "gson/src/main/java",
};

describe("sourceUrl", () => {
  it("joins the repo-relative root onto the model-relative anchor, GitHub style", () => {
    expect(sourceUrl(gson, { file: "com/google/gson/Gson.java", span: [83, 1712] })).toBe(
      "https://github.com/google/gson/blob/4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1/" +
        "gson/src/main/java/com/google/gson/Gson.java#L83-L1712",
    );
  });

  it("uses the GitLab template on a GitLab host, hyphen segment and all", () => {
    const app: RepositoryFacts = {
      remote: "https://gitlab.com/team/app",
      commit: "b".repeat(40),
      root: "src",
    };
    expect(sourceUrl(app, { file: "Main.java", span: [4, 9] })).toBe(
      `https://gitlab.com/team/app/-/blob/${"b".repeat(40)}/src/Main.java#L4-9`,
    );
  });

  it("lets `provider` override a hostname that does not say — self-hosted GitLab", () => {
    const selfHosted: RepositoryFacts = {
      remote: "https://code.acme.io/team/app",
      commit: "c".repeat(40),
      root: "",
      provider: "gitlab",
    };
    expect(sourceUrl(selfHosted, { file: "Main.java", span: [1, 2] })).toBe(
      `https://code.acme.io/team/app/-/blob/${"c".repeat(40)}/Main.java#L1-2`,
    );
  });

  it("says nothing for a host whose scheme is unknown — no template is a guess", () => {
    const unknown: RepositoryFacts = {
      remote: "https://code.acme.io/team/app",
      commit: "c".repeat(40),
      root: "",
    };
    expect(sourceUrl(unknown, { file: "Main.java", span: [1, 2] })).toBeUndefined();
  });

  it("links the whole file when the source has no line range", () => {
    expect(sourceUrl(gson, { file: "com/google/gson/Gson.java" })).toBe(
      "https://github.com/google/gson/blob/4b9d4a51ea36d18a0e6e1c0bc0f3d1a8b3a5f0c1/" +
        "gson/src/main/java/com/google/gson/Gson.java",
    );
  });

  it("collapses a one-line span to a single anchor", () => {
    expect(sourceUrl(gson, { file: "A.java", span: [7, 7] })?.endsWith("#L7")).toBe(true);
  });

  it("takes a per-frame commit — a replay links to the revision on screen", () => {
    const scrubbed = "a".repeat(40);
    expect(sourceUrl(gson, { file: "A.java" }, scrubbed)).toContain(`/blob/${scrubbed}/`);
  });

  it("has nothing to link without a repository or without an anchor", () => {
    expect(sourceUrl(undefined, { file: "A.java", span: [1, 2] })).toBeUndefined();
    expect(sourceUrl(gson, undefined)).toBeUndefined();
  });

  it("keeps the root out of the path when the analyzed root IS the repo root", () => {
    expect(sourceUrl({ ...gson, root: "" }, { file: "A.java" })).toBe(
      `https://github.com/google/gson/blob/${gson.commit}/A.java`,
    );
  });
});
