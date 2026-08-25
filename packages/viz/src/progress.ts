/**
 * The artifact-download progress line, DOM-free. A real corpus's city.json is
 * tens of megabytes; the loader page stays up while it streams in, and this
 * module owns the arithmetic so the honest cases are tested: a server that
 * states a Content-Length gets a fraction, one that does not gets only the
 * received count — a bar never claims a fraction it cannot know.
 */

const MEGABYTE = 1024 * 1024;

function megabytes(bytes: number): string {
  return (bytes / MEGABYTE).toFixed(1);
}

export function progressLabel(received: number, total: number | null): string {
  return total === null || total <= 0
    ? `loading city — ${megabytes(received)} MB`
    : `loading city — ${megabytes(received)} / ${megabytes(total)} MB`;
}

/** 0..1 of the download, or null when the total is unknown or nonsense. */
export function progressFraction(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(received / total, 1);
}
