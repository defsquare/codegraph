import { useRef } from "react";

/**
 * The empty state, and the error state. Both are an invitation to act: what to
 * drop, and the exact command that produces it. An error names what was wrong
 * with the file, in the guard's own words.
 */
export function Loader({
  error,
  onFile,
}: {
  readonly error: string | undefined;
  readonly onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="app app-loader">
      <div className="loader-card">
        <h1>codegraph navigator</h1>
        {error === undefined ? (
          <p className="loader-lead">
            Drop a <code>navigator.json</code> here, or pick one.
          </p>
        ) : (
          <p className="loader-error">{error}</p>
        )}
        <p className="loader-command">
          <code>codegraph navigator model.jsonl --out navigator.json</code>
          <span className="loader-or">or serve it directly with</span>
          <code>codegraph navigator model.jsonl --serve</code>
        </p>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) onFile(file);
          }}
        />
      </div>
    </div>
  );
}
