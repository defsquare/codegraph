/**
 * THE APP FORM of the page (PLAN §15.2): when the daemon behind the desktop
 * app serves it, the same bundle also talks to the daemon's routes — `app`,
 * `recent`, `jobs` and the `jobs/current` event stream — all RELATIVE, so
 * they resolve under the per-launch `/<token>/` exactly as `navigator.json`
 * does. Nothing here is Tauri: no `@tauri-apps/*`, no IPC — a browser on the
 * daemon's URL is the development loop, and the shell is one more browser.
 *
 * Every constant is RESTATED as a literal (the CLI owns them, and this
 * package imports its model packages for types only — a value import would
 * drag the Node pipeline into the bundle).
 */
export const APP_KIND = "codegraph.app/1";
export const RECENT_KIND = "codegraph.recent/1";

export interface ExtractorInfo {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface JobSummary {
  readonly src: string;
  readonly name: string;
  readonly extractor: string | null;
}

export type JobState = "running" | "done" | "failed";

export interface AppInfo {
  readonly extractors: readonly ExtractorInfo[];
  readonly current: (JobSummary & { readonly state: JobState }) | null;
}

export interface RecentProject extends JobSummary {
  readonly openedAt: string;
  readonly nodes: number;
  readonly deps: number;
}

type Fetch = typeof fetch;

/**
 * Is this page served by the daemon? A 200 with the app kind says yes; a 404
 * (the classic `codegraph serve`, a static host) or an unreachable route says
 * no — quietly, since a page opened outside the app is the ordinary case.
 */
export async function probeApp(fetchImpl: Fetch = fetch): Promise<AppInfo | undefined> {
  let response: Response;
  try {
    response = await fetchImpl("app", { cache: "no-store" });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as { kind?: unknown; extractors?: unknown; current?: unknown };
  if (candidate.kind !== APP_KIND || !Array.isArray(candidate.extractors)) return undefined;
  return {
    extractors: candidate.extractors as ExtractorInfo[],
    current: (candidate.current ?? null) as AppInfo["current"],
  };
}

export async function fetchRecent(fetchImpl: Fetch = fetch): Promise<readonly RecentProject[]> {
  try {
    const response = await fetchImpl("recent", { cache: "no-store" });
    if (!response.ok) return [];
    const parsed = (await response.json()) as { kind?: unknown; projects?: unknown };
    return parsed.kind === RECENT_KIND && Array.isArray(parsed.projects) ? (parsed.projects as RecentProject[]) : [];
  } catch {
    return [];
  }
}

export interface Candidate {
  readonly name: string;
  readonly files: number;
}

/** What `POST jobs` answered, as the page has to act on it. */
export type SubmitOutcome =
  | { readonly kind: "accepted"; readonly job: JobSummary }
  | { readonly kind: "busy"; readonly job: JobSummary }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "no-extractor"; readonly seen: readonly string[] }
  | { readonly kind: "unknown-extractor"; readonly name: string }
  | { readonly kind: "not-found"; readonly src: string }
  | { readonly kind: "not-a-model"; readonly src: string }
  | { readonly kind: "error"; readonly message: string };

export async function submitJob(
  request: { readonly src: string; readonly extractor?: string | undefined },
  fetchImpl: Fetch = fetch,
): Promise<SubmitOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.extractor === undefined ? { src: request.src } : request),
    });
  } catch (error) {
    return { kind: "error", message: `the daemon could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* an empty or non-JSON body: the status alone decides */
  }
  if (response.status === 202 && typeof body["job"] === "object" && body["job"] !== null) {
    return { kind: "accepted", job: body["job"] as JobSummary };
  }
  switch (body["error"]) {
    case "busy":
      return { kind: "busy", job: body["job"] as JobSummary };
    case "ambiguous":
      return { kind: "ambiguous", candidates: (body["candidates"] ?? []) as Candidate[] };
    case "no-extractor":
      return { kind: "no-extractor", seen: (body["seen"] ?? []) as string[] };
    case "unknown-extractor":
      return { kind: "unknown-extractor", name: String(body["name"] ?? "") };
    case "not-found":
      return { kind: "not-found", src: String(body["src"] ?? request.src) };
    case "not-a-model":
      return { kind: "not-a-model", src: String(body["src"] ?? request.src) };
    default:
      return { kind: "error", message: `the daemon answered HTTP ${response.status}` };
  }
}

export type JobPhase = "detect" | "extract" | "build";

export interface DoneData extends JobSummary {
  readonly nodes: number;
  readonly deps: number;
  readonly buildings: number;
}

export interface FailedData {
  readonly message: string;
  readonly exitCode: number | null;
  readonly stderr: readonly string[];
}

/** The daemon's SSE events — the CLI's `JobEvent`, restated. */
export type JobEvent =
  | { readonly event: "idle" }
  | { readonly event: "started"; readonly data: JobSummary }
  | { readonly event: "phase"; readonly data: { readonly phase: JobPhase; readonly detail: string } }
  | { readonly event: "progress"; readonly data: { readonly line: string } }
  | { readonly event: "done"; readonly data: DoneData }
  | { readonly event: "failed"; readonly data: FailedData };

/** One SSE message → an event, or undefined for anything malformed (dropped, never thrown). */
export function parseJobEvent(type: string, data: string): JobEvent | undefined {
  if (type === "idle") return { event: "idle" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  switch (type) {
    case "started":
      return typeof record["src"] === "string" ? { event: "started", data: record as unknown as JobSummary } : undefined;
    case "phase":
      return typeof record["phase"] === "string" && typeof record["detail"] === "string"
        ? { event: "phase", data: record as unknown as { phase: JobPhase; detail: string } }
        : undefined;
    case "progress":
      return typeof record["line"] === "string" ? { event: "progress", data: { line: record["line"] } } : undefined;
    case "done":
      return typeof record["src"] === "string" && typeof record["nodes"] === "number"
        ? { event: "done", data: record as unknown as DoneData }
        : undefined;
    case "failed":
      return typeof record["message"] === "string"
        ? {
            event: "failed",
            data: {
              message: record["message"],
              exitCode: typeof record["exitCode"] === "number" ? record["exitCode"] : null,
              stderr: Array.isArray(record["stderr"]) ? (record["stderr"] as string[]) : [],
            },
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * What the page shows of a job: the phases so far, the last progress lines,
 * and how it ended. Reduced from the event stream — a replay (the daemon
 * resends the current job's events to a reconnecting subscriber) starts with
 * `started`, which resets the view, so replays never duplicate.
 */
export interface JobView {
  readonly job: JobSummary;
  readonly state: JobState;
  readonly phases: readonly { readonly phase: JobPhase; readonly detail: string }[];
  readonly progress: readonly string[];
  readonly result?: { readonly nodes: number; readonly deps: number; readonly buildings: number } | undefined;
  readonly failure?: FailedData | undefined;
}

/** How many progress lines the view keeps — a window on the extractor, not a log. */
export const PROGRESS_WINDOW = 12;

export function reduceJob(view: JobView | undefined, event: JobEvent): JobView | undefined {
  switch (event.event) {
    case "idle":
      return undefined;
    case "started":
      return { job: event.data, state: "running", phases: [], progress: [] };
    case "phase":
      return view === undefined ? view : { ...view, phases: [...view.phases, event.data] };
    case "progress":
      return view === undefined
        ? view
        : { ...view, progress: [...view.progress, event.data.line].slice(-PROGRESS_WINDOW) };
    case "done":
      return view === undefined
        ? view
        : { ...view, state: "done", result: { nodes: event.data.nodes, deps: event.data.deps, buildings: event.data.buildings } };
    case "failed":
      return view === undefined ? view : { ...view, state: "failed", failure: event.data };
  }
}

/** "3 minutes ago", "yesterday", or the date — for the recents list. */
export function formatAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return then.toISOString().slice(0, 10);
}
