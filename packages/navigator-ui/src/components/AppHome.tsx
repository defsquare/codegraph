import { useState } from "react";
import {
  formatAge,
  type AppInfo,
  type Candidate,
  type JobView,
  type RecentProject,
  type SubmitOutcome,
} from "../app-mode.js";

/**
 * THE EMPTY STATE IN APP FORM (PLAN §15.2): what the page shows under the
 * daemon when no project is open — the recents, the open instruction (the
 * SHELL owns the folder dialog and the drop; the page only asks), and, while
 * a job runs, its progress: the phases so far, a window on the extractor's
 * own stderr, and how it ended.
 *
 * The path field is the DEVELOPMENT LOOP: a browser on the daemon's URL has
 * no native dialog, so a typed path is how a folder is opened from a checkout.
 * In the shell it is one more way to open, never the only one.
 */
export interface AppHomeProps {
  readonly info: AppInfo;
  readonly recent: readonly RecentProject[];
  readonly job: JobView | undefined;
  /** The last `POST jobs` the page itself made, and its answer — what to say about it. */
  readonly outcome: { readonly src: string; readonly result: SubmitOutcome } | undefined;
  /** A navigator artifact that arrived and was wrong, in the guard's words. */
  readonly loadError: string | undefined;
  readonly onOpen: (src: string, extractor?: string) => void;
}

const PHASE_TEXT = {
  detect: "Detecting the extractor",
  extract: "Extracting the model",
  build: "Building the page",
} as const;

export function AppHome({ info, recent, job, outcome, loadError, onOpen }: AppHomeProps) {
  const [path, setPath] = useState("");
  const running = job?.state === "running";
  const asked = outcome?.result.kind === "ambiguous" ? { src: outcome.src, candidates: outcome.result.candidates } : undefined;
  const missing =
    outcome?.result.kind === "not-installed" ? { src: outcome.src, extractors: outcome.result.extractors } : undefined;
  const refused =
    outcome !== undefined && asked === undefined && missing === undefined && outcome.result.kind !== "accepted"
      ? outcome.result
      : undefined;

  return (
    <div className="app app-loader">
      <div className="loader-card home-card">
        <h1>codegraph</h1>
        <p className="loader-lead">
          Open a folder: <strong>File › Open…</strong> <kbd>⌘O</kbd>, or drop a folder on the window.
        </p>
        <form
          className="home-open"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = path.trim();
            if (trimmed.length > 0 && !running) onOpen(trimmed);
          }}
        >
          <input
            type="text"
            value={path}
            placeholder="…or type a folder or model.jsonl path"
            spellCheck={false}
            aria-label="Folder or model.jsonl path"
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" className="home-button" disabled={running || path.trim().length === 0}>
            Open
          </button>
        </form>

        {info.extractors.length === 0 ? (
          <p className="home-note">
            No extractors are registered — only a <code>model.jsonl</code> opens. Pass{" "}
            <code>--extractors registry.json</code> to the daemon for folders.
          </p>
        ) : (
          <p className="home-note">
            Extractors:{" "}
            {info.extractors.map((extractor, index) => (
              <span key={extractor.name} className={extractor.installed ? "home-extractor" : "home-extractor home-extractor-missing"}>
                {index > 0 && " · "}
                {extractor.name} ({extractor.extensions.join(", ")}){extractor.installed ? "" : " — not installed"}
              </span>
            ))}
          </p>
        )}

        {asked !== undefined && (
          <Question candidates={asked.candidates} onPick={(name) => onOpen(asked.src, name)} />
        )}
        {missing !== undefined && (
          <NotInstalled extractors={missing.extractors} onRetry={() => onOpen(missing.src)} />
        )}
        {refused !== undefined && <p className="loader-error">{describeOutcome(refused)}</p>}
        {loadError !== undefined && <p className="loader-error">{loadError}</p>}

        {job !== undefined && <JobPanel job={job} />}

        {recent.length > 0 && (
          <section className="home-recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((project) => (
                <li key={project.src}>
                  <button
                    type="button"
                    className="home-recent-row"
                    disabled={running}
                    title={project.src}
                    onClick={() => onOpen(project.src)}
                  >
                    <span className="home-recent-name">{project.name}</span>
                    <span className="home-recent-src">{project.src}</span>
                    <span className="home-recent-meta">
                      {project.extractor ?? "model"} · {project.nodes.toLocaleString()} nodes · {formatAge(project.openedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * "Which extractor?" — one button per installed claimant; a claimant that is
 * not installed is offered with its install line rather than hidden, so the
 * answer "the language you meant is the one you have not installed yet" is
 * visible instead of silently excluded.
 */
function Question({ candidates, onPick }: { readonly candidates: readonly Candidate[]; readonly onPick: (name: string) => void }) {
  return (
    <div className="home-question" role="group" aria-label="Which extractor?">
      <p>Several extractors claim this folder. Which one?</p>
      <div className="home-question-choices">
        {candidates.map((candidate) =>
          candidate.install === undefined ? (
            <button key={candidate.name} type="button" className="home-button" onClick={() => onPick(candidate.name)}>
              {candidate.name} <span className="home-question-count">{candidate.files.toLocaleString()} files</span>
            </button>
          ) : (
            <span key={candidate.name} className="home-question-missing">
              {candidate.name} <span className="home-question-count">{candidate.files.toLocaleString()} files</span> — not
              installed: <code>{candidate.install}</code>
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The folder's language has no extractor on this machine: the line that
 * installs it, and "Check again" — a plain retry, since the shell rewrites
 * the registry whenever it rescans (window focus, its menu) and the daemon
 * reads the file again on the next request. No IPC in the page.
 */
function NotInstalled({
  extractors,
  onRetry,
}: {
  readonly extractors: readonly (Candidate & { readonly install: string })[];
  readonly onRetry: () => void;
}) {
  return (
    <div className="home-question home-not-installed" role="group" aria-label="Extractor not installed">
      <p>
        {extractors.length === 1
          ? `This folder needs the ${extractors[0]?.name} extractor, which is not installed.`
          : "This folder needs an extractor that is not installed."}
      </p>
      <ul className="home-install-lines">
        {extractors.map((extractor) => (
          <li key={extractor.name}>
            <span className="home-install-name">
              {extractor.name} <span className="home-question-count">{extractor.files.toLocaleString()} files</span>
            </span>
            <code>{extractor.install}</code>
          </li>
        ))}
      </ul>
      <button type="button" className="home-button" onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}

function describeOutcome(outcome: SubmitOutcome): string {
  switch (outcome.kind) {
    case "accepted":
    case "ambiguous":
    case "not-installed":
      return "";
    case "busy":
      return `A job is already running on ${outcome.job.src}; wait for it to finish.`;
    case "no-extractor":
      return `No registered extractor claims this folder (it holds ${outcome.seen.slice(0, 8).join(", ") || "no source files"}).`;
    case "unknown-extractor":
      return `No extractor named '${outcome.name}' is registered.`;
    case "not-found":
      return `${outcome.src} is not a folder or a file this machine can see.`;
    case "not-a-model":
      return `${outcome.src} is a file but not a model.jsonl; open its folder instead.`;
    case "error":
      return outcome.message;
  }
}

function JobPanel({ job }: { readonly job: JobView }) {
  const done = job.state === "done";
  const failed = job.state === "failed";
  const currentPhase = job.phases.at(-1)?.phase;
  return (
    <section className={`home-job home-job-${job.state}`} role="status" aria-live="polite">
      <h2>
        {job.state === "running" ? "Opening" : done ? "Opened" : "Could not open"} <code>{job.job.name}</code>
        {job.job.extractor !== null && <span className="home-job-extractor"> with {job.job.extractor}</span>}
      </h2>
      <ol className="home-phases">
        {(["detect", "extract", "build"] as const).map((phase) => {
          const seen = job.phases.find((candidate) => candidate.phase === phase);
          const state =
            seen === undefined ? "pending" : phase === currentPhase && job.state === "running" ? "active" : "done";
          return (
            <li key={phase} className={`home-phase home-phase-${state}`}>
              <span className="home-phase-name">{PHASE_TEXT[phase]}</span>
              {seen !== undefined && <span className="home-phase-detail">{seen.detail}</span>}
            </li>
          );
        })}
      </ol>
      {job.progress.length > 0 && !done && (
        <pre className="home-progress">{job.progress.join("\n")}</pre>
      )}
      {failed && job.failure !== undefined && (
        <div className="loader-error">
          <p>{job.failure.message}</p>
          {job.failure.stderr.length > 0 && <pre className="home-progress">{job.failure.stderr.join("\n")}</pre>}
        </div>
      )}
      {done && job.result !== undefined && (
        <p className="home-note">
          {job.result.nodes.toLocaleString()} nodes · {job.result.deps.toLocaleString()} dependency rows ·{" "}
          {job.result.buildings.toLocaleString()} buildings
        </p>
      )}
    </section>
  );
}
