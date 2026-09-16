import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildNavigator, navigatorToJsonString } from "@codegraph/navigator";
import { cityToJsonString, layoutCity } from "@codegraph/city";
import type { CityBuildOptions } from "../args.js";
import { cityOf } from "../commands/city.js";
import { errLine, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { cliVersion } from "../version.js";
import { resolveView } from "../view.js";
import {
  census,
  detect,
  launchOf,
  treeFingerprint,
  type Candidate,
  type Census,
  type ExtractorEntry,
  type Registry,
} from "./registry.js";
import {
  buildKeyOf,
  projectDirFor,
  pushRecent,
  readProject,
  writeProject,
  PROJECT_KIND,
  type ProjectRecord,
} from "./store.js";

/**
 * THE JOB: a folder in, the page's two artifacts out (PLAN §15.2).
 *
 *   detect   census the tree against the registry (registry.ts)
 *   extract  run the entry under the §13.5 contract into <data-dir>/models/…,
 *            or skip it when the tree fingerprint has not moved
 *   build    navigator.json + laid-out city.json from ONE graph under ONE view —
 *            exactly what `serveCommand` does for a model on argv — through
 *            `openAnalysis`, so the model.db beside the model is the M7 cache
 *
 * ONE AT A TIME. The build is synchronous CPU work on the event loop (the CLI's
 * whole pipeline is), and two extractors racing on one machine help nobody; a
 * second request while one runs is a 409 the page understands.
 *
 * EVENTS, NOT LOGS. Every step is an event with a small JSON payload; the SSE
 * route replays the current job's events to a late subscriber and streams the
 * rest, so a page that connects mid-job sees the whole story.
 */
export type JobPhase = "detect" | "extract" | "build";

export interface JobSummary {
  readonly src: string;
  readonly name: string;
  readonly extractor: string | null;
}

export interface ProjectSummary extends JobSummary {
  readonly nodes: number;
  readonly deps: number;
  readonly buildings: number;
}

export type JobEvent =
  | { readonly event: "started"; readonly data: JobSummary }
  | { readonly event: "phase"; readonly data: { readonly phase: JobPhase; readonly detail: string } }
  | { readonly event: "progress"; readonly data: { readonly line: string } }
  | { readonly event: "done"; readonly data: ProjectSummary }
  | {
      readonly event: "failed";
      readonly data: { readonly message: string; readonly exitCode: number | null; readonly stderr: readonly string[] };
    };

export type JobState = "running" | "done" | "failed";

export interface JobRequest {
  readonly src: string;
  readonly extractor?: string | undefined;
}

export type StartOutcome =
  | { readonly kind: "accepted"; readonly job: JobSummary }
  | { readonly kind: "busy"; readonly job: JobSummary }
  | { readonly kind: "not-found"; readonly src: string }
  | { readonly kind: "not-a-model"; readonly src: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "not-installed"; readonly extractors: readonly (Candidate & { readonly install: string })[] }
  | { readonly kind: "no-extractor"; readonly seen: readonly string[] }
  | { readonly kind: "unknown-extractor"; readonly name: string };

export interface Artifacts {
  readonly navigator: string;
  readonly city: string;
  readonly project: ProjectSummary;
}

export interface CurrentJob {
  readonly job: JobSummary;
  readonly state: JobState;
}

export interface JobRunner {
  start(request: JobRequest): StartOutcome;
  /** Replays the current job's events, then streams new ones. Returns the unsubscribe. */
  subscribe(listener: (event: JobEvent) => void): () => void;
  readonly current: CurrentJob | undefined;
  /** The current project's page — the last job that finished. */
  readonly artifacts: Artifacts | undefined;
  /** Kill a running extractor; the daemon calls this on its way out. */
  shutdown(): void;
}

export interface JobRunnerOptions {
  readonly dataDir: string;
  /** The registry, asked for on every job: the shell rewrites its file after a rescan. */
  readonly registry: () => Registry;
  /** The city channels and view — the same flags `serve` takes — plus the cache switch. */
  readonly build: CityBuildOptions & { readonly noCache: boolean };
  readonly io: IoSink;
  readonly spawn?: typeof spawnProcess;
  readonly now?: () => Date;
}

/** How many trailing stderr lines a failure carries: enough to name the cause, not a log. */
const STDERR_TAIL = 8;

interface Plan {
  readonly job: JobSummary;
  readonly src: string;
  /** Present for a folder; absent for a model opened directly. */
  readonly extraction:
    | { readonly entry: ExtractorEntry & { readonly path: string }; readonly counted: Census; readonly files: number }
    | undefined;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const spawn = options.spawn ?? spawnProcess;
  const now = options.now ?? (() => new Date());
  const { io } = options;

  let current: { job: JobSummary; state: JobState; events: JobEvent[] } | undefined;
  let artifacts: Artifacts | undefined;
  let child: ChildProcess | undefined;
  const listeners = new Set<(event: JobEvent) => void>();

  const emit = (event: JobEvent): void => {
    current?.events.push(event);
    for (const listener of listeners) listener(event);
  };

  const fail = (message: string, exitCode: number | null, stderr: readonly string[]): void => {
    if (current !== undefined) current.state = "failed";
    errLine(io, `job: failed — ${message}`);
    emit({ event: "failed", data: { message, exitCode, stderr } });
  };

  const phase = (name: JobPhase, detail: string): void => {
    errLine(io, `job: ${name} — ${detail}`);
    emit({ event: "phase", data: { phase: name, detail } });
  };

  function plan(request: JobRequest): Plan | StartOutcome {
    const src = resolve(request.src);
    let stat;
    try {
      stat = statSync(src);
    } catch {
      return { kind: "not-found", src };
    }
    if (stat.isFile()) {
      if (!src.toLowerCase().endsWith(".jsonl")) return { kind: "not-a-model", src };
      return { job: { src, name: basename(src).replace(/\.jsonl$/i, ""), extractor: null }, src, extraction: undefined };
    }
    if (!stat.isDirectory()) return { kind: "not-found", src };

    const registry = options.registry();
    const counted = census(src, registry);
    const decision = detect(counted, registry, request.extractor);
    switch (decision.kind) {
      case "ambiguous":
        return { kind: "ambiguous", candidates: decision.candidates };
      case "not-installed":
        return { kind: "not-installed", extractors: decision.extractors };
      case "none":
        return { kind: "no-extractor", seen: decision.seen };
      case "unknown":
        return { kind: "unknown-extractor", name: decision.name };
      case "one":
        return {
          job: { src, name: basename(src), extractor: decision.entry.name },
          src,
          extraction: { entry: decision.entry, counted, files: decision.files },
        };
    }
  }

  /** Run the extractor into `modelPath`; resolves with the exit code, rejects only on a spawn failure. */
  function extract(
    entry: ExtractorEntry & { readonly path: string },
    src: string,
    modelPath: string,
  ): Promise<{ code: number | null; stderr: string[] }> {
    const line = launchOf(entry, ["--src", src, "--out", modelPath, "--progress", "plain"]);
    return new Promise((resolvePromise, reject) => {
      const process_ = spawn(line.command, line.args, {
        env: { ...process.env, ...line.env },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child = process_;
      const tail: string[] = [];
      let pending = "";
      process_.stderr?.setEncoding("utf8");
      process_.stderr?.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const text of lines) {
          if (text.trim().length === 0) continue;
          tail.push(text);
          if (tail.length > STDERR_TAIL) tail.shift();
          emit({ event: "progress", data: { line: text } });
        }
      });
      process_.once("error", (error) => {
        child = undefined;
        reject(error);
      });
      process_.once("close", (code) => {
        child = undefined;
        if (pending.trim().length > 0) {
          tail.push(pending);
          emit({ event: "progress", data: { line: pending } });
        }
        resolvePromise({ code, stderr: tail });
      });
    });
  }

  async function run(planned: Plan): Promise<void> {
    const projectDir = projectDirFor(options.dataDir, planned.src);
    mkdirSync(projectDir, { recursive: true });
    const previous = readProject(projectDir);

    let modelPath = planned.src;
    let fingerprint: string | null = null;
    let extractedAt: string | null = null;

    if (planned.extraction !== undefined) {
      const { entry, counted, files } = planned.extraction;
      phase("detect", `${files} ${files === 1 ? "file" : "files"} for ${entry.name}`);
      fingerprint = treeFingerprint(counted, entry);
      modelPath = join(projectDir, "model.jsonl");
      const unchanged =
        previous !== undefined &&
        previous.extractor === entry.name &&
        previous.fingerprint === fingerprint &&
        existsSync(modelPath);
      if (unchanged) {
        extractedAt = previous.extractedAt;
        phase("extract", `unchanged since ${previous.extractedAt ?? "the last run"}; reusing the model`);
      } else {
        phase("extract", `running ${entry.name} on ${planned.src}`);
        let result;
        try {
          result = await extract(entry, planned.src, modelPath);
        } catch (error) {
          fail(`cannot run ${entry.name} at ${entry.path}: ${error instanceof Error ? error.message : String(error)}`, null, []);
          return;
        }
        if (result.code !== 0) {
          fail(`${entry.name} exited with ${result.code ?? "a signal"}`, result.code, result.stderr);
          return;
        }
        extractedAt = now().toISOString();
      }
    }

    const buildKey = buildKeyOf(options.build, cliVersion());
    const navigatorPath = join(projectDir, "navigator.json");
    const cityPath = join(projectDir, "city.json");
    const reusable =
      previous !== undefined &&
      previous.model === modelPath &&
      previous.fingerprint === fingerprint &&
      previous.buildKey === buildKey &&
      existsSync(navigatorPath) &&
      existsSync(cityPath);

    let record: ProjectRecord;
    let navigator: string;
    let city: string;
    if (reusable) {
      phase("build", `unchanged; reusing the page built ${previous.builtAt}`);
      navigator = readFileSync(navigatorPath, "utf8");
      city = readFileSync(cityPath, "utf8");
      record = { ...previous, extractedAt };
    } else {
      phase("build", `building the navigator and the city from ${modelPath}`);
      const source = openAnalysis([modelPath], options.build, io);
      try {
        const graph = source.graph();
        const view = resolveView(options.build);
        const navigatorModel = buildNavigator(graph, {
          view,
          ...(options.build.name === undefined ? {} : { name: options.build.name }),
        });
        const cityModel = layoutCity(cityOf(graph, options.build));
        navigator = navigatorToJsonString(navigatorModel);
        city = cityToJsonString(cityModel);
        if (!source.clean) errLine(io, `job: warning — the model is not clean; the page was built anyway.`);
        record = {
          kind: PROJECT_KIND,
          src: planned.src,
          name: planned.job.name,
          extractor: planned.job.extractor,
          model: modelPath,
          fingerprint,
          extractedAt,
          buildKey,
          builtAt: now().toISOString(),
          nodes: navigatorModel.nodes.length,
          deps: navigatorModel.deps.length,
          buildings: cityModel.buildings.length,
        };
      } finally {
        source.close();
      }
      writeFileSync(navigatorPath, navigator, "utf8");
      writeFileSync(cityPath, city, "utf8");
    }
    writeProject(projectDir, record);

    const project: ProjectSummary = {
      ...planned.job,
      nodes: record.nodes,
      deps: record.deps,
      buildings: record.buildings,
    };
    pushRecent(options.dataDir, {
      src: planned.src,
      name: planned.job.name,
      extractor: planned.job.extractor,
      openedAt: now().toISOString(),
      nodes: record.nodes,
      deps: record.deps,
    });
    artifacts = { navigator, city, project };
    if (current !== undefined) current.state = "done";
    errLine(io, `job: done — ${project.name}: ${project.nodes} nodes, ${project.deps} dependency rows`);
    emit({ event: "done", data: project });
  }

  return {
    start(request) {
      if (current?.state === "running") return { kind: "busy", job: current.job };
      const planned = plan(request);
      if ("kind" in planned) return planned;
      current = { job: planned.job, state: "running", events: [] };
      errLine(io, `job: opening ${planned.src}${planned.job.extractor === null ? "" : ` with ${planned.job.extractor}`}`);
      emit({ event: "started", data: planned.job });
      // Off this tick: the 202 goes out before any synchronous work begins.
      setImmediate(() => {
        run(planned).catch((error: unknown) => {
          fail(error instanceof Error ? error.message : String(error), null, []);
        });
      });
      return { kind: "accepted", job: planned.job };
    },
    subscribe(listener) {
      for (const event of current?.events ?? []) listener(event);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get current() {
      return current === undefined ? undefined : { job: current.job, state: current.state };
    },
    get artifacts() {
      return artifacts;
    },
    shutdown() {
      child?.kill();
      child = undefined;
    },
  };
}
