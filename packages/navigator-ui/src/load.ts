import type { NavigatorModel } from "@codegraph/navigator";
import { parseNavigatorModel } from "./guard.js";
import { buildIndexes, type ModelIndexes } from "./model/indexes.js";

/**
 * NO ARTIFACT WAS THERE — a 404, a refused connection, a dropped link. This is
 * a different fact from "the bytes arrived and are not a navigator artifact"
 * (`NavigatorLoadError`), and the two get opposite treatment on the quiet
 * path: probing `/navigator.json` when nothing is served must fall through to
 * the empty state and offer the picker, while a file that IS there and is
 * wrong must say so.
 */
export class ArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUnavailableError";
  }
}

/**
 * ONE loading pipeline for every source — fetch or dropped file:
 *
 *   read bytes  ->  parse JSON  ->  build indexes
 *
 * Progress is reported per phase so the overlay can show a DETERMINATE bar
 * while bytes stream in (the CLI server and the dev middleware both send
 * content-length) and a staged label for the two synchronous phases. The
 * yields before parse/index give the browser one frame to paint that label —
 * `JSON.parse` over a real corpus blocks for seconds and nothing can progress
 * inside it honestly, so the phases are named rather than faked.
 */
export type LoadPhase = "reading" | "parsing" | "indexing";

export interface LoadProgress {
  readonly phase: LoadPhase;
  readonly receivedBytes: number;
  /** Absent when the source did not say (no content-length). */
  readonly totalBytes?: number;
}

export type OnProgress = (progress: LoadProgress) => void;

const nextFrame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function finish(text: string, onProgress: OnProgress): Promise<ModelIndexes> {
  const bytes = text.length;
  onProgress({ phase: "parsing", receivedBytes: bytes, totalBytes: bytes });
  await nextFrame();
  const model: NavigatorModel = parseNavigatorModel(text);
  onProgress({ phase: "indexing", receivedBytes: bytes, totalBytes: bytes });
  await nextFrame();
  return buildIndexes(model);
}

export async function loadFromUrl(url: string, onProgress: OnProgress): Promise<ModelIndexes> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new ArtifactUnavailableError(
      `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ArtifactUnavailableError(`${url}: HTTP ${response.status}`);
  }
  const lengthHeader = response.headers.get("content-length");
  const totalBytes = lengthHeader === null ? undefined : Number(lengthHeader);
  const body = response.body;
  if (body === null) return finish(await response.text(), onProgress);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
    onProgress({
      phase: "reading",
      receivedBytes,
      ...(totalBytes === undefined || Number.isNaN(totalBytes) ? {} : { totalBytes }),
    });
  }
  parts.push(decoder.decode());
  return finish(parts.join(""), onProgress);
}

export async function loadFromFile(file: Blob, onProgress: OnProgress): Promise<ModelIndexes> {
  onProgress({ phase: "reading", receivedBytes: 0, totalBytes: file.size });
  const text = await file.text();
  return finish(text, onProgress);
}
