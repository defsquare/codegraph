import { useMemo, useState } from "react";
import type { NavCycleComponent, NavCycleReport } from "@codegraph/navigator";
import type { ModelIndexes } from "../model/indexes.js";
import { ancestorsOf } from "../model/indexes.js";

/**
 * The cycles report — Structure101's tangle view over the artifact's
 * precomputed `reports.cycles`. Nothing is derived here: the components, the
 * minimum feedback set and the tangle metric all arrive from the analyzer;
 * this tab's one job is to make the CUT actionable — the feedback edges are
 * the rows a reader acts on, so they lead, marked, with their cost.
 */

export interface CyclesViewProps {
  readonly ix: ModelIndexes;
  readonly onReveal: (node: number) => void;
}

const LEVEL_LABEL: Readonly<Record<NavCycleReport["level"], string>> = {
  module: "Modules",
  type: "Types",
};

/** How many members / kept links show before the reader asks for the rest. */
const MEMBER_PREVIEW = 24;
const EDGE_PREVIEW = 12;

function modulePath(ix: ModelIndexes, node: number): string {
  return ancestorsOf(ix.model, node)
    .map((ancestor) => ix.model.nodes[ancestor]?.name ?? "?")
    .join(" › ");
}

function Component({
  ix,
  component,
  rank,
  onReveal,
}: {
  ix: ModelIndexes;
  component: NavCycleComponent;
  rank: number;
  onReveal: (node: number) => void;
}) {
  const [open, setOpen] = useState(rank === 0);
  const [allMembers, setAllMembers] = useState(false);
  const [allEdges, setAllEdges] = useState(false);

  // The cut first — the edges a reader acts on — then the rest by weight.
  const ordered = useMemo(() => {
    const feedback = component.edges.filter((edge) => edge.feedback);
    const kept = component.edges.filter((edge) => !edge.feedback);
    kept.sort((a, b) => b.count - a.count);
    return { feedback, kept };
  }, [component]);

  const members = allMembers ? component.members : component.members.slice(0, MEMBER_PREVIEW);
  const keptShown = allEdges ? ordered.kept : ordered.kept.slice(0, EDGE_PREVIEW);

  return (
    <section className="cycle">
      <button type="button" className="cycle-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="cycle-title">
          {component.members.length} <em>mutually dependent</em>
        </span>
        <span className="cycle-numbers">
          <span title="Base edges inside the cycle">weight {component.weight}</span>
          <span title="Share of the cycle's references the minimal cut severs — Structure101's tangle metric">
            tangle {(component.tangleMetric * 100).toFixed(0)}%
          </span>
          <span className="cycle-cut" title="References severed by cutting the marked links">
            cut {ordered.feedback.length} link{ordered.feedback.length === 1 ? "" : "s"} ·{" "}
            {component.feedbackWeight} ref{component.feedbackWeight === 1 ? "" : "s"}
          </span>
        </span>
      </button>
      {open && (
        <div className="cycle-body">
          <div className="cycle-members">
            {members.map((member) => (
              <button
                key={member}
                type="button"
                className="cycle-member"
                title={modulePath(ix, member)}
                onClick={() => onReveal(member)}
              >
                {ix.model.nodes[member]?.name ?? "?"}
              </button>
            ))}
            {!allMembers && component.members.length > MEMBER_PREVIEW && (
              <button type="button" className="cycle-more" onClick={() => setAllMembers(true)}>
                +{component.members.length - MEMBER_PREVIEW} more
              </button>
            )}
          </div>
          <table className="cycle-edges">
            <thead>
              <tr>
                <th scope="col">Cut</th>
                <th scope="col">Dependency</th>
                <th scope="col" className="num">refs</th>
                <th scope="col">Provenance</th>
              </tr>
            </thead>
            <tbody>
              {[...ordered.feedback, ...keptShown].map((edge) => (
                <tr key={`${edge.from}:${edge.to}`} className={edge.feedback ? "cycle-feedback" : undefined}>
                  <td className="cycle-scissors">{edge.feedback ? "✂" : ""}</td>
                  <td>
                    <button type="button" className="cycle-endpoint" onClick={() => onReveal(edge.from)}>
                      {ix.model.nodes[edge.from]?.name ?? "?"}
                    </button>
                    <span className="cycle-arrow"> → </span>
                    <button type="button" className="cycle-endpoint" onClick={() => onReveal(edge.to)}>
                      {ix.model.nodes[edge.to]?.name ?? "?"}
                    </button>
                  </td>
                  <td className="num">{edge.count}</td>
                  <td>
                    {edge.allDeclared ? (
                      <span className="prov-declared">declared</span>
                    ) : (
                      <span className="provenance" title="At least one aggregated edge is an inference">
                        {edge.provenances.join(", ")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!allEdges && ordered.kept.length > EDGE_PREVIEW && (
            <button type="button" className="cycle-more" onClick={() => setAllEdges(true)}>
              show all {component.edges.length} links
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function CyclesView({ ix, onReveal }: CyclesViewProps) {
  const reports = ix.model.reports?.cycles;
  const [level, setLevel] = useState<NavCycleReport["level"]>("module");
  const report = reports?.find((candidate) => candidate.level === level);
  const components = useMemo(
    () => [...(report?.components ?? [])].sort((a, b) => b.weight - a.weight),
    [report],
  );

  if (reports === undefined) {
    return (
      <main className="report-view report-empty">
        <p>
          This artifact predates cycle reports. Regenerate it —{" "}
          <code>codegraph navigator model.jsonl --out navigator.json</code> — to see them.
        </p>
      </main>
    );
  }

  return (
    <main className="report-view">
      <div className="report-toolbar">
        <div className="seg" role="group" aria-label="Cycle level">
          {reports.map((candidate) => (
            <button
              key={candidate.level}
              type="button"
              className={candidate.level === level ? "seg-on" : undefined}
              onClick={() => setLevel(candidate.level)}
            >
              {LEVEL_LABEL[candidate.level]}
              <span className="seg-count">{candidate.components.length}</span>
            </button>
          ))}
        </div>
        {report !== undefined && report.components.length > 0 && (
          <span className="report-summary">
            tangle {(report.tangle.metric * 100).toFixed(1)}% — cutting{" "}
            {report.tangle.feedbackEdgeCount} link{report.tangle.feedbackEdgeCount === 1 ? "" : "s"} (
            {report.tangle.feedbackWeight} of {report.tangle.cyclicWeight} cyclic refs) makes the graph
            acyclic
          </span>
        )}
      </div>
      {components.length === 0 ? (
        <p className="report-clear">
          No cycles at the {LEVEL_LABEL[level].toLowerCase()} level — this graph is acyclic.
        </p>
      ) : (
        components.map((component, index) => (
          <Component
            key={component.members[0] ?? index}
            ix={ix}
            component={component}
            rank={index}
            onReveal={onReveal}
          />
        ))
      )}
    </main>
  );
}
