export type ProgressMode = "auto" | "plain" | "none";

export interface Sink {
  write(text: string): void;
  readonly isTerminal: boolean;
}

/**
 * One line per phase on stderr (`--progress plain`), nothing when piped
 * (`auto` while stderr is not a terminal) or silenced. stderr is a read
 * format here — the summary lands on it — so a redirected run is
 * byte-identical to one without progress at all.
 */
export class Progress {
  readonly #enabled: boolean;

  constructor(
    mode: ProgressMode,
    private readonly err: Sink,
  ) {
    this.#enabled = mode === "plain" || (mode === "auto" && err.isTerminal);
  }

  static silent(): Progress {
    return new Progress("none", { write: () => undefined, isTerminal: false });
  }

  phase<T>(name: string, work: () => T, detail: (result: T) => string): T {
    const started = process.hrtime.bigint();
    const result = work();
    if (this.#enabled) {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.err.write(`✓ ${name.padEnd(10)} ${detail(result)}  ${seconds.toFixed(1)}s\n`);
    }
    return result;
  }
}
