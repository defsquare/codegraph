import { useEffect, useMemo, useState } from "react";
import { blockFacts, createInsightLoader, type Insight } from "../insight.js";

/**
 * What `codegraph explain` wrote about the selected node, under its header.
 *
 * AN INFERENCE NEVER LOOKS LIKE A FACT (CLAUDE.md invariant 2, and the
 * dependency rows' rule). Everything else on this page is extracted from the
 * source; this is a language model's reading of it. So the block wears the
 * page's inference colour, says who wrote it and how sure it claimed to be,
 * and a templated explanation — computed, no model involved — says that
 * instead.
 *
 * Nothing to show renders NOTHING: no store, no such route, an id nobody
 * explained. The header looks exactly as it did before explanations existed.
 */

/** One loader for the page: an id is asked for once, however often it is reselected. */
const loader = createInsightLoader();

export interface InsightPanelProps {
  /** The selected node's rendered entity id — types and modules carry one. */
  readonly id: string;
}

export function InsightPanel({ id }: InsightPanelProps) {
  const [shown, setShown] = useState<{ readonly id: string; readonly insight: Insight } | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void loader.load(id).then((insight) => {
      // A slow answer for a node the reader has already left must not land on the next one.
      if (current) setShown({ id, insight });
    });
    return () => {
      current = false;
    };
  }, [id]);

  const insight = shown?.id === id ? shown.insight : undefined;
  const facts = useMemo(() => (insight?.status === "explained" ? blockFacts(insight.block) : []), [insight]);

  if (insight === undefined || insight.status === "none") return null;

  if (insight.status === "failed") {
    return (
      <section className="insight insight-failed">
        <p className="insight-byline">
          <span className="insight-badge">not explained</span>
          {insight.model !== undefined && <span>{insight.model}</span>}
          {insight.attempts !== undefined && <span>{insight.attempts === 1 ? "1 attempt" : `${insight.attempts} attempts`}</span>}
        </p>
        <p className="insight-reason">{insight.reason}</p>
      </section>
    );
  }

  const templated = insight.origin === "template";
  return (
    <section className="insight">
      <p className="insight-byline">
        <span className="insight-badge">{templated ? "templated" : "LLM explanation"}</span>
        {insight.concept !== undefined && <span className="insight-concept">{insight.concept}</span>}
        {!templated && insight.model !== undefined && <span>{insight.model}</span>}
        {insight.confidence !== undefined && (
          <span title="The model's own confidence in this explanation, 0 to 1 — a hint, not a measurement.">
            confidence <strong>{insight.confidence.toFixed(2)}</strong>
          </span>
        )}
      </p>
      <p className="insight-text">{insight.description}</p>
      {facts.length > 0 && (
        <details className="insight-facts">
          <summary>Domain reading — {facts.length} {facts.length === 1 ? "fact" : "facts"}</summary>
          <dl>
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>
                  {fact.values.map((value, index) => (
                    <span key={`${fact.label}-${index}`}>{value}</span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}
