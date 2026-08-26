import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigatorLoadError } from "../src/guard.js";
import { ArtifactUnavailableError, loadFromUrl, type LoadProgress } from "../src/load.js";
import { artifact } from "./fixture.js";

/**
 * THE TWO FAILURES ARE NOT THE SAME FACT, and the load ceremony treats them
 * oppositely: probing `/navigator.json` when nothing is served falls through
 * to the empty state, while an artifact that IS there and is wrong is
 * reported. Getting this backwards showed a scary error message on the
 * ordinary "opened the page with no model" path, so it is pinned here.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function respondWith(body: string, init: { status?: number } = {}): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    }),
  ) as unknown as typeof fetch;
}

const noProgress = (_: LoadProgress): void => {};

describe("loading an artifact over HTTP", () => {
  it("reports a missing artifact as UNAVAILABLE, not as a bad artifact", async () => {
    respondWith("Not Found", { status: 404 });
    await expect(loadFromUrl("/navigator.json", noProgress)).rejects.toBeInstanceOf(
      ArtifactUnavailableError,
    );
    await expect(loadFromUrl("/navigator.json", noProgress)).rejects.not.toBeInstanceOf(
      NavigatorLoadError,
    );
  });

  it("reports an unreachable server as unavailable too", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(loadFromUrl("/navigator.json", noProgress)).rejects.toBeInstanceOf(
      ArtifactUnavailableError,
    );
  });

  it("reports a served file that is not an artifact as a LOAD error", async () => {
    respondWith(JSON.stringify({ schemaVersion: "1.0.0", entities: [], edges: [] }));
    await expect(loadFromUrl("/navigator.json", noProgress)).rejects.toBeInstanceOf(
      NavigatorLoadError,
    );
  });

  it("loads and indexes a real artifact, reporting each phase", async () => {
    const body = JSON.stringify(artifact());
    respondWith(body);
    const phases: LoadProgress[] = [];
    const ix = await loadFromUrl("/navigator.json", (progress) => phases.push(progress));
    expect(ix.model.nodes).toHaveLength(6);
    expect(ix.depsByFrom.get(1)).toEqual([0, 1, 2]);
    expect(phases.map((phase) => phase.phase)).toContain("parsing");
    expect(phases.map((phase) => phase.phase)).toContain("indexing");
    // The determinate bar needs a total; the server sends content-length.
    expect(phases.some((phase) => phase.totalBytes === body.length)).toBe(true);
  });
});
