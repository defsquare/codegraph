import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { ModelIndexes } from "../model/indexes.js";
import { ancestorsOf } from "../model/indexes.js";
import {
  DEFAULT_GRAPH_CAP,
  graphDisplay,
  type GraphDisplay,
  type GraphMode,
} from "../model/graph.js";

cytoscape.use(fcose);

/**
 * The dependency graph tab — the audit-tools arch_viz, re-homed. Cytoscape +
 * fcose; two modes (modules rolled up / types clustered inside their module
 * compounds); node size ∝ fan-in; labels appear by zoom tier so the far view
 * stays a shape, not a word cloud.
 *
 * COLOR IS SEMANTIC here exactly as everywhere else in this app. The tab adds
 * ONE categorical channel — module membership tints node fills — and reuses
 * the app's own hues for everything that means something: focus a node and
 * its incoming edges light cyan (fan-in), outgoing amber (fan-out); a link
 * carrying any inference is dashed violet (invariant 2). A stub stays muted:
 * a degraded fact, not a category.
 */

/** Module-membership fills, tuned for the dark ground; index = hue slot. */
const MODULE_FILLS: readonly string[] = [
  "#5b8dd9", "#4caf82", "#c98a4b", "#b36fb3", "#5fb3b3", "#c96a6a",
  "#8a9a4b", "#7b7fd4", "#c9a227", "#4b9ac9", "#b37b9e", "#6baf5b",
];
const STUB_FILL = "#4a5560";
const RULE = "#39424e";
const FADED_OPACITY = 0.08;
const IN = "#4cc4d6";
const OUT = "#e0a34a";
const INFERENCE = "#a98cf0";
const PAPER = "#dfe5ec";
const PAPER_DIM = "#97a3b2";

export interface GraphViewProps {
  readonly ix: ModelIndexes;
  readonly hideExternals: boolean;
  readonly active: boolean;
  readonly selection: number | undefined;
  readonly onSelect: (node: number | undefined) => void;
  readonly onReveal: (node: number) => void;
}

function nodeSize(fanIn: number, mode: GraphMode): number {
  return mode === "modules"
    ? Math.max(26, Math.min(80, 26 + Math.sqrt(fanIn) * 12))
    : Math.max(10, Math.min(46, 10 + Math.sqrt(fanIn) * 7));
}

function edgeWidth(count: number): number {
  return Math.max(1, Math.min(6, 0.8 + Math.log2(count)));
}

export function GraphView({ ix, hideExternals, active, selection, onSelect, onReveal }: GraphViewProps) {
  const [mode, setMode] = useState<GraphMode>("modules");
  const [minFanIn, setMinFanIn] = useState(0);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const fitZoom = useRef(1);
  const labelState = useRef("");

  const display: GraphDisplay = useMemo(
    () => graphDisplay(ix.model, { mode, hideExternals, minFanIn }),
    [ix.model, mode, hideExternals, minFanIn],
  );

  /**
   * Labels by zoom tier, relative to the fitted zoom (arch_viz's rule). A
   * small drawing labels everything; a dense one earns its labels by zooming —
   * fan-in > 0 first, the rest deeper. Modules tier in sooner: their labels
   * are the only thing that identifies a cluster.
   */
  const refreshLabels = useCallback((cy: Core, currentMode: GraphMode, force: boolean) => {
    const small = (cy.scratch("nodeCount") as number) <= 60;
    const zoom = cy.zoom();
    const [t1, t2] = currentMode === "modules" ? [1.6, 4] : [2.3, 6];
    const tier1 = small || zoom >= fitZoom.current * t1;
    const tier2 = small || zoom >= fitZoom.current * t2;
    const state = `${tier1}/${tier2}`;
    if (state === labelState.current && !force) return;
    labelState.current = state;
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        if (node.isParent()) return;
        const want = (node.data("fanIn") as number) > 0 ? tier1 : tier2;
        node[want ? "addClass" : "removeClass"]("lbl");
      });
    });
  }, []);

  // One instance for the tab's life; elements rebuilt when the display changes.
  useEffect(() => {
    if (container.current === null) return undefined;
    const cy = cytoscape({
      container: container.current,
      wheelSensitivity: 0.6,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(fill)",
            label: "data(label)",
            "font-size": 9,
            color: PAPER,
            "text-opacity": 0,
            width: "data(size)",
            height: "data(size)",
            "border-width": 0,
          },
        },
        {
          selector: "node.stub",
          style: { "background-color": STUB_FILL, "border-width": 1, "border-color": PAPER_DIM, "border-style": "dashed" },
        },
        {
          selector: "node.parent",
          style: {
            "background-opacity": 0.05,
            "background-color": "data(fill)",
            "border-width": 1,
            "border-color": RULE,
            label: "data(label)",
            "font-size": 12,
            "text-valign": "top",
            "text-opacity": 1,
            color: PAPER_DIM,
            shape: "round-rectangle",
          },
        },
        {
          selector: "edge",
          style: {
            width: "data(w)",
            "line-color": RULE,
            "target-arrow-color": RULE,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.7,
            "curve-style": "straight",
            opacity: 0.55,
          },
        },
        {
          selector: "edge.inferred",
          style: { "line-style": "dashed", "line-color": INFERENCE, "target-arrow-color": INFERENCE, opacity: 0.5 },
        },
        { selector: ".lbl", style: { "text-opacity": 1 } },
        { selector: ".faded", style: { opacity: FADED_OPACITY, "text-opacity": 0 } },
        { selector: "node.focus", style: { "border-width": 2, "border-color": PAPER, "text-opacity": 1 } },
        { selector: "node.hi", style: { "text-opacity": 1 } },
        {
          selector: "edge.in",
          style: { "line-color": IN, "target-arrow-color": IN, opacity: 0.95, width: 2 },
        },
        {
          selector: "edge.out",
          style: { "line-color": OUT, "target-arrow-color": OUT, opacity: 0.95, width: 2 },
        },
      ],
    });
    cy.on("zoom", () => refreshLabels(cy, cy.scratch("mode") as GraphMode, false));
    cyRef.current = cy;
    // Debug/scripting handle, the same convenience arch_viz exposed.
    (window as unknown as { cy?: Core }).cy = cy;
    return () => {
      cyRef.current = undefined;
      delete (window as unknown as { cy?: Core }).cy;
      cy.destroy();
    };
  }, [refreshLabels]);

  // Rebuild elements and lay out when the display set changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === undefined) return;
    cy.scratch("mode", mode);
    const elements: cytoscape.ElementDefinition[] = [];
    if (mode === "types") {
      // A compound wears its children's hue — one lookup, no second hashing.
      const parents = new Map<number, number>();
      for (const node of display.nodes) {
        if (node.module !== undefined && !parents.has(node.module)) parents.set(node.module, node.hue);
      }
      for (const [parent, hue] of parents) {
        const entry = ix.model.nodes[parent];
        elements.push({
          data: {
            id: `M${parent}`,
            label: entry?.name ?? "?",
            fill: MODULE_FILLS[hue] ?? RULE,
          },
          classes: "parent",
        });
      }
    }
    for (const node of display.nodes) {
      elements.push({
        data: {
          id: `N${node.node}`,
          label: node.label,
          fill: node.stub ? STUB_FILL : (MODULE_FILLS[node.hue] ?? RULE),
          size: nodeSize(node.fanIn, mode),
          fanIn: node.fanIn,
          ...(mode === "types" && node.module !== undefined ? { parent: `M${node.module}` } : {}),
        },
        ...(node.stub ? { classes: "stub" } : {}),
      });
    }
    for (const edge of display.edges) {
      elements.push({
        data: {
          id: `E${edge.from}_${edge.to}`,
          source: `N${edge.from}`,
          target: `N${edge.to}`,
          w: edgeWidth(edge.count),
          count: edge.count,
        },
        ...(edge.allDeclared ? {} : { classes: "inferred" }),
      });
    }
    cy.elements().remove();
    cy.add(elements);
    const layout =
      mode === "modules"
        ? { name: "fcose", quality: "proof", animate: false, nodeSeparation: 110, idealEdgeLength: 130 }
        : {
            name: "fcose",
            quality: "default",
            animate: false,
            packComponents: true,
            nodeSeparation: 70,
            nestingFactor: 0.1,
          };
    cy.layout(layout as cytoscape.LayoutOptions).run();
    cy.fit(undefined, 30);
    fitZoom.current = cy.zoom();
    labelState.current = "";
    cy.scratch("nodeCount", display.nodes.length);
    refreshLabels(cy, mode, true);
  }, [display, ix.model, mode, refreshLabels]);

  // Focus follows the app-wide selection; incoming cyan, outgoing amber.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === undefined) return;
    cy.elements().removeClass("faded focus hi in out");
    if (selection === undefined) return;
    const node = cy.getElementById(`N${selection}`);
    if (node.length === 0) return;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(".parent").addClass("faded");
    neighborhood.removeClass("faded").addClass("hi");
    node.addClass("focus");
    node.incomers("edge").removeClass("faded").addClass("in");
    node.outgoers("edge").removeClass("faded").addClass("out");
    // A selection made in another tab may be off-screen: bring it into view.
    const extent = cy.extent();
    const position = node.position();
    const visible =
      position.x >= extent.x1 && position.x <= extent.x2 &&
      position.y >= extent.y1 && position.y <= extent.y2;
    if (!visible) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) cy.fit(neighborhood, 120);
      else cy.animate({ fit: { eles: neighborhood, padding: 120 }, duration: 300 });
    }
  }, [selection, display]);

  // Tap wiring: node → app selection; background → clear.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === undefined) return undefined;
    const onTap = (event: cytoscape.EventObject) => {
      if (event.target === cy) {
        onSelect(undefined);
        return;
      }
      const id = (event.target as cytoscape.NodeSingular).id?.();
      if (typeof id === "string" && id.startsWith("N")) onSelect(Number(id.slice(1)));
    };
    cy.on("tap", onTap);
    return () => {
      cy.off("tap", onTap);
    };
  }, [onSelect]);

  // A canvas laid out while hidden has no size — resize when the tab shows.
  useEffect(() => {
    const cy = cyRef.current;
    if (active && cy !== undefined) {
      cy.resize();
      if (cy.elements().length > 0 && cy.extent().w === 0) cy.fit(undefined, 30);
    }
  }, [active]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return undefined;
    return display.nodes.filter((node) => node.label.toLowerCase().includes(needle));
  }, [display, query]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy === undefined || matches === undefined) return;
    cy.elements().removeClass("faded hi in out focus");
    if (matches.length === 0) return;
    cy.elements().not(".parent").addClass("faded");
    const found = cy.collection();
    for (const match of matches) found.merge(cy.getElementById(`N${match.node}`));
    found.removeClass("faded").addClass("hi");
    found.connectedEdges().removeClass("faded");
    cy.fit(found, 80);
  }, [matches]);

  const selected = selection === undefined ? undefined : ix.model.nodes[selection];
  const selectedPath =
    selection === undefined
      ? ""
      : ancestorsOf(ix.model, selection)
          .map((ancestor) => ix.model.nodes[ancestor]?.name ?? "?")
          .join(" › ");

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <div className="seg" role="group" aria-label="Graph mode">
          <button
            type="button"
            className={mode === "modules" ? "seg-on" : undefined}
            onClick={() => setMode("modules")}
          >
            Modules
          </button>
          <button
            type="button"
            className={mode === "types" ? "seg-on" : undefined}
            onClick={() => setMode("types")}
          >
            Types
          </button>
        </div>
        {mode === "types" && (
          <label className="graph-slider">
            fan-in ≥ <b>{minFanIn}</b>
            <input
              type="range"
              min={0}
              max={30}
              value={minFanIn}
              onChange={(event) => setMinFanIn(Number(event.target.value))}
            />
          </label>
        )}
        <input
          type="search"
          className="graph-search"
          placeholder="Find in graph…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="graph-stats">
          {display.nodes.length.toLocaleString()} nodes · {display.edges.length.toLocaleString()} links
        </span>
        {display.truncated && (
          <span className="graph-truncated" role="status">
            {display.totalNodes.toLocaleString()} pass the filters — drawing the top{" "}
            {DEFAULT_GRAPH_CAP.toLocaleString()} by fan-in. Raise the fan-in floor to choose the slice.
          </span>
        )}
      </div>
      <div className="graph-canvas" ref={container} />
      <div className="graph-legend">
        <span><i className="lg-line" /> declared</span>
        <span><i className="lg-line lg-dashed" /> inference</span>
        <span><i className="lg-line lg-in" /> incoming</span>
        <span><i className="lg-line lg-out" /> outgoing</span>
        <span><i className="lg-dot" /> fill = module</span>
      </div>
      {selected !== undefined && selection !== undefined && (
        <aside className="graph-details">
          <div className="graph-details-name">
            <code className={selected.isStub ? "stub" : undefined}>{selected.name}</code>
          </div>
          {selectedPath !== "" && <div className="graph-details-path">{selectedPath}</div>}
          {selected.metrics !== undefined && (
            <div className="graph-details-metrics">
              <span className="metric-in">fan-in {selected.metrics.fanIn}</span>
              <span className="metric-out">fan-out {selected.metrics.fanOut}</span>
              <span>I = {selected.metrics.instability.toFixed(2)}</span>
            </div>
          )}
          <button type="button" className="graph-details-reveal" onClick={() => onReveal(selection)}>
            Reveal in tree
          </button>
        </aside>
      )}
    </div>
  );
}
