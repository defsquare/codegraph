import type { LoadProgress } from "../load.js";

/**
 * Shown only when initialization outlasts two seconds. It states the phase in
 * the reader's terms and shows a determinate bar while bytes are arriving —
 * the artifact route sends content-length. Parsing and indexing are single
 * blocking calls with no honest sub-progress, so they get a named stripe
 * rather than a fake percentage.
 */
const PHASE_TEXT = {
  reading: "Reading the model",
  parsing: "Parsing the model",
  indexing: "Building the indexes",
} as const;

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function ProgressOverlay({ progress }: { readonly progress: LoadProgress | undefined }) {
  const phase = progress?.phase ?? "reading";
  const determinate =
    progress !== undefined &&
    progress.phase === "reading" &&
    progress.totalBytes !== undefined &&
    progress.totalBytes > 0;
  const ratio = determinate
    ? Math.min(1, progress.receivedBytes / (progress.totalBytes as number))
    : undefined;

  return (
    <div className="app app-progress" role="status" aria-live="polite">
      <div className="progress-card">
        <h1>codegraph navigator</h1>
        <p className="progress-phase">{PHASE_TEXT[phase]}</p>
        <div className={`progress-track${determinate ? "" : " indeterminate"}`}>
          <div
            className="progress-fill"
            style={determinate ? { width: `${(ratio as number) * 100}%` } : undefined}
          />
        </div>
        <p className="progress-detail">
          {determinate
            ? `${megabytes(progress.receivedBytes)} of ${megabytes(progress.totalBytes as number)}`
            : progress !== undefined && progress.receivedBytes > 0
              ? megabytes(progress.receivedBytes)
              : " "}
        </p>
      </div>
    </div>
  );
}
