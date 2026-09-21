import { insightsStorePathFor } from "@codegraph/insights";

/**
 * WHERE A MODEL'S INSIGHTS LIVE. `explain` writes them and `insights` reads
 * them; both must agree, and the reader must not import the writer — that
 * module pulls in the provider SDK, which a query has no business loading.
 */

/** `X.jsonl` → `X.insights.jsonl`: the side-car sits beside the model. */
export function sidecarPathFor(modelPath: string): string {
  return modelPath.endsWith(".jsonl") ? `${modelPath.slice(0, -".jsonl".length)}.insights.jsonl` : `${modelPath}.insights.jsonl`;
}

/** `X.jsonl` → `X.insights.db`: the store sits beside the side-car it exports. */
export function storePathForModel(modelPath: string): string {
  return insightsStorePathFor(sidecarPathFor(modelPath));
}
