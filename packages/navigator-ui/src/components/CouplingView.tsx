import { useMemo, useState } from "react";
import type { NodeCategory } from "@codegraph/navigator";
import type { ModelIndexes } from "../model/indexes.js";
import { ancestorsOf } from "../model/indexes.js";

/**
 * The coupling report: every node the artifact carries metrics for, ranked.
 * Fan-in, fan-out and instability all arrive precomputed from the analyzer
 * (`coupling()` at each category's fold level); this tab sorts and shows.
 *
 * The instability bar renders I = Ce/(Ca+Ce) between its two poles: 0 = stable
 * (everything depends on it, it depends on nothing — cyan, the fan-in hue) and
 * 1 = unstable (amber, the fan-out hue). The bar reuses those hues because it
 * IS that ratio, not a new meaning.
 */

export interface CouplingViewProps {
  readonly ix: ModelIndexes;
  readonly hideExternals: boolean;
  readonly onReveal: (node: number) => void;
}

type SortKey = "fanIn" | "fanOut" | "instability" | "name";

/** Rows shown at once — search narrows, the cap keeps the DOM honest. */
const ROW_CAP = 500;

interface Row {
  readonly node: number;
  readonly name: string;
  readonly stub: boolean;
  readonly path: string;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly instability: number;
}

export function CouplingView({ ix, hideExternals, onReveal }: CouplingViewProps) {
  const [category, setCategory] = useState<Extract<NodeCategory, "module" | "type">>("type");
  const [sortKey, setSortKey] = useState<SortKey>("fanIn");
  const [descending, setDescending] = useState(true);
  const [query, setQuery] = useState("");

  const rows: readonly Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const [index, node] of ix.model.nodes.entries()) {
      if (node.category !== category || node.metrics === undefined) continue;
      if (hideExternals && node.isStub) continue;
      out.push({
        node: index,
        name: node.name,
        stub: node.isStub,
        path: ancestorsOf(ix.model, index)
          .map((ancestor) => ix.model.nodes[ancestor]?.name ?? "?")
          .join(" › "),
        fanIn: node.metrics.fanIn,
        fanOut: node.metrics.fanOut,
        instability: node.metrics.instability,
      });
    }
    return out;
  }, [ix.model, category, hideExternals]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle === "" ? [...rows] : rows.filter((row) => row.name.toLowerCase().includes(needle));
    const direction = descending ? -1 : 1;
    filtered.sort((a, b) => {
      const delta =
        sortKey === "name" ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a[sortKey] - b[sortKey];
      return delta * direction || (a.name < b.name ? -1 : 1);
    });
    return filtered;
  }, [rows, query, sortKey, descending]);

  const header = (key: SortKey, label: string, title: string) => (
    <th scope="col" className={key === "name" ? undefined : "num"}>
      <button
        type="button"
        className={sortKey === key ? "sort sort-on" : "sort"}
        title={title}
        onClick={() => {
          if (sortKey === key) setDescending(!descending);
          else {
            setSortKey(key);
            setDescending(key !== "name");
          }
        }}
      >
        {label}
        {sortKey === key && <span className="sort-dir">{descending ? "▾" : "▴"}</span>}
      </button>
    </th>
  );

  return (
    <main className="report-view">
      <div className="report-toolbar">
        <div className="seg" role="group" aria-label="Coupling level">
          <button
            type="button"
            className={category === "module" ? "seg-on" : undefined}
            onClick={() => setCategory("module")}
          >
            Modules
          </button>
          <button
            type="button"
            className={category === "type" ? "seg-on" : undefined}
            onClick={() => setCategory("type")}
          >
            Types
          </button>
        </div>
        <input
          type="search"
          className="graph-search"
          placeholder={`Filter ${category === "module" ? "modules" : "types"}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="report-summary">
          {shown.length > ROW_CAP
            ? `top ${ROW_CAP} of ${shown.length.toLocaleString()} — filter to narrow`
            : `${shown.length.toLocaleString()} ${category === "module" ? "modules" : "types"}`}
        </span>
      </div>
      <table className="coupling-table">
        <thead>
          <tr>
            {header("name", "Name", "Sort by name")}
            {header("fanIn", "Fan-in", "Distinct dependents (Ca)")}
            {header("fanOut", "Fan-out", "Distinct dependencies (Ce)")}
            {header("instability", "Instability", "I = Ce / (Ca + Ce): 0 stable — 1 unstable")}
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, ROW_CAP).map((row) => (
            <tr key={row.node}>
              <td className="coupling-name">
                <button type="button" className="counterpart" onClick={() => onReveal(row.node)}>
                  <span className={row.stub ? "counterpart-name stub" : "counterpart-name"}>{row.name}</span>
                </button>
                {row.path !== "" && <span className="dep-path">{row.path}</span>}
              </td>
              <td className="num metric-in">{row.fanIn}</td>
              <td className="num metric-out">{row.fanOut}</td>
              <td className="num coupling-i">
                <span className="i-bar" aria-hidden="true">
                  <span className="i-fill" style={{ width: `${Math.round(row.instability * 100)}%` }} />
                </span>
                {row.instability.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
