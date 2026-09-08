/** A decorator factory: an ordinary function; its USES are annotationUse edges. */
export function Audited(tag: string, verbose = false) {
  return (_target: unknown, _context?: unknown): void => {
    void tag;
    void verbose;
  };
}

@Audited("monthly")
export class Report {
  @Audited("max", true)
  max(values: number[]): number {
    let best = values[0] ?? 0;
    for (const value of values) {
      if (value > best) best = value;
    }
    return best;
  }
}
