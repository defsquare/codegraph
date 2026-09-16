import { describe, expect, it } from "vitest";
import {
  fetchRecent,
  formatAge,
  parseJobEvent,
  probeApp,
  reduceJob,
  submitJob,
  type JobEvent,
  type JobView,
} from "../src/app-mode.js";

/**
 * The page's side of the daemon contract (PLAN §15.2): which answer means
 * "this is the app", how each `POST jobs` status is acted on, and how the
 * event stream becomes the progress view. Fetch is faked; nothing here needs
 * a DOM — the components render what these functions decide.
 */
function respond(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const refuse: typeof fetch = async () => {
  throw new TypeError("Failed to fetch");
};

describe("probeApp", () => {
  it("recognizes the daemon by the app kind, relatively — the route resolves under the token", async () => {
    let asked = "";
    const fetchImpl: typeof fetch = async (input) => {
      asked = String(input);
      return new Response(
        JSON.stringify({
          kind: "codegraph.app/1",
          extractors: [
            { name: "java", extensions: [".java"], installed: true },
            { name: "elixir", extensions: [".ex"], installed: false, install: "brew install defsquare/tap/codegraph-elixir" },
          ],
          current: null,
        }),
      );
    };
    const info = await probeApp(fetchImpl);
    expect(asked).toBe("app");
    expect(info?.extractors.map((extractor) => [extractor.name, extractor.installed])).toEqual([
      ["java", true],
      ["elixir", false],
    ]);
    expect(info?.extractors[1]?.install).toBe("brew install defsquare/tap/codegraph-elixir");
  });

  it("answers undefined — quietly — for a 404, a wrong kind or no server at all", async () => {
    expect(await probeApp(respond(404, ""))).toBeUndefined();
    expect(await probeApp(respond(200, { kind: "codegraph.navigator/1" }))).toBeUndefined();
    expect(await probeApp(respond(200, "<html>"))).toBeUndefined();
    expect(await probeApp(refuse)).toBeUndefined();
  });
});

describe("fetchRecent", () => {
  it("returns the projects, or nothing when the route is absent or wrong", async () => {
    const projects = [{ src: "/p", name: "p", extractor: "java", openedAt: "2026-09-16T10:00:00Z", nodes: 1, deps: 2 }];
    expect(await fetchRecent(respond(200, { kind: "codegraph.recent/1", projects }))).toEqual(projects);
    expect(await fetchRecent(respond(404, ""))).toEqual([]);
    expect(await fetchRecent(respond(200, { kind: "other", projects }))).toEqual([]);
    expect(await fetchRecent(refuse)).toEqual([]);
  });
});

describe("submitJob", () => {
  const job = { src: "/p", name: "p", extractor: "java" };

  it("posts the src (and the extractor only when answering a question)", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ job }), { status: 202 });
    };
    expect(await submitJob({ src: "/p" }, fetchImpl)).toEqual({ kind: "accepted", job });
    await submitJob({ src: "/p", extractor: "java" }, fetchImpl);
    expect(bodies).toEqual([`{"src":"/p"}`, `{"src":"/p","extractor":"java"}`]);
  });

  it.each([
    [409, { error: "busy", job }, { kind: "busy", job }],
    [422, { error: "ambiguous", candidates: [{ name: "java", files: 3 }] }, { kind: "ambiguous", candidates: [{ name: "java", files: 3 }] }],
    [
      422,
      { error: "not-installed", extractors: [{ name: "elixir", files: 2, install: "brew install x" }] },
      { kind: "not-installed", extractors: [{ name: "elixir", files: 2, install: "brew install x" }] },
    ],
    [422, { error: "no-extractor", seen: [".py"] }, { kind: "no-extractor", seen: [".py"] }],
    [422, { error: "unknown-extractor", name: "go" }, { kind: "unknown-extractor", name: "go" }],
    [404, { error: "not-found", src: "/p" }, { kind: "not-found", src: "/p" }],
    [422, { error: "not-a-model", src: "/p" }, { kind: "not-a-model", src: "/p" }],
    [500, "", { kind: "error", message: "the daemon answered HTTP 500" }],
  ])("maps HTTP %i %j to a typed outcome", async (status, body, expected) => {
    expect(await submitJob({ src: "/p" }, respond(status, body))).toEqual(expected);
  });

  it("reports an unreachable daemon as an error, not a throw", async () => {
    expect(await submitJob({ src: "/p" }, refuse)).toMatchObject({ kind: "error" });
  });
});

describe("parseJobEvent + reduceJob", () => {
  const started = parseJobEvent("started", JSON.stringify({ src: "/p", name: "p", extractor: "java" })) as JobEvent;

  it("parses every event kind and drops garbage", () => {
    expect(started).toEqual({ event: "started", data: { src: "/p", name: "p", extractor: "java" } });
    expect(parseJobEvent("idle", "{}")).toEqual({ event: "idle" });
    expect(parseJobEvent("phase", `{"phase":"extract","detail":"running java"}`)).toEqual({
      event: "phase",
      data: { phase: "extract", detail: "running java" },
    });
    expect(parseJobEvent("progress", `{"line":"3 files"}`)).toEqual({ event: "progress", data: { line: "3 files" } });
    expect(parseJobEvent("done", `{"src":"/p","name":"p","extractor":"java","nodes":10,"deps":20,"buildings":3}`)).toMatchObject({
      event: "done",
      data: { nodes: 10 },
    });
    expect(parseJobEvent("failed", `{"message":"java exited with 1","exitCode":1,"stderr":["boom"]}`)).toEqual({
      event: "failed",
      data: { message: "java exited with 1", exitCode: 1, stderr: ["boom"] },
    });
    expect(parseJobEvent("progress", "not json")).toBeUndefined();
    expect(parseJobEvent("phase", `{"phase":"extract"}`)).toBeUndefined();
    expect(parseJobEvent("nonsense", "{}")).toBeUndefined();
  });

  it("builds the view: phases accumulate, progress is a window, the end sets the state", () => {
    let view: JobView | undefined = reduceJob(undefined, started);
    expect(view).toMatchObject({ state: "running", phases: [], progress: [] });
    view = reduceJob(view, { event: "phase", data: { phase: "detect", detail: "3 files for java" } });
    for (let i = 0; i < 20; i += 1) view = reduceJob(view, { event: "progress", data: { line: `line ${i}` } });
    expect(view?.phases).toEqual([{ phase: "detect", detail: "3 files for java" }]);
    expect(view?.progress).toHaveLength(12);
    expect(view?.progress[0]).toBe("line 8");
    const done = reduceJob(view, {
      event: "done",
      data: { src: "/p", name: "p", extractor: "java", nodes: 10, deps: 20, buildings: 3 },
    });
    expect(done).toMatchObject({ state: "done", result: { nodes: 10, deps: 20, buildings: 3 } });
    const failed = reduceJob(view, { event: "failed", data: { message: "boom", exitCode: 1, stderr: ["x"] } });
    expect(failed).toMatchObject({ state: "failed", failure: { exitCode: 1 } });
  });

  it("resets on a replayed `started` and clears on `idle`, so a reconnect never duplicates", () => {
    let view = reduceJob(undefined, started);
    view = reduceJob(view, { event: "progress", data: { line: "a" } });
    view = reduceJob(view, started);
    expect(view?.progress).toEqual([]);
    expect(reduceJob(view, { event: "idle" })).toBeUndefined();
    // Events before any `started` (a stale stream) are ignored rather than crashing.
    expect(reduceJob(undefined, { event: "progress", data: { line: "a" } })).toBeUndefined();
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  it("speaks in the reader's units", () => {
    expect(formatAge("2026-09-16T11:59:50Z", now)).toBe("just now");
    expect(formatAge("2026-09-16T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatAge("2026-09-16T10:00:00Z", now)).toBe("2 hours ago");
    expect(formatAge("2026-09-15T12:00:00Z", now)).toBe("yesterday");
    expect(formatAge("2026-09-10T12:00:00Z", now)).toBe("6 days ago");
    expect(formatAge("2026-06-01T12:00:00Z", now)).toBe("2026-06-01");
    expect(formatAge("garbage", now)).toBe("");
  });
});
