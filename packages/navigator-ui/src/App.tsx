import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelIndexes } from "./model/indexes.js";
import { expandedToReveal } from "./model/flatten.js";
import { ArtifactUnavailableError, loadFromFile, loadFromUrl, type LoadProgress } from "./load.js";
import { TreePanel } from "./components/TreePanel.js";
import { DepsView } from "./components/DepsView.js";
import { GraphView } from "./components/GraphView.js";
import { CyclesView } from "./components/CyclesView.js";
import { CouplingView } from "./components/CouplingView.js";
import { CityTab } from "./components/CityTab.js";
import { ProgressOverlay } from "./components/ProgressOverlay.js";
import { Loader } from "./components/Loader.js";

/**
 * Load ceremony, same order as the city viewer: `?src=URL` (loud) → the
 * sibling `/navigator.json` (quiet when absent — the CLI's `--serve` route or
 * the dev middleware) → drag & drop / file picker. The artifact is the ONLY
 * input; the guard refuses everything else with the command that produces one.
 */
type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly progress: LoadProgress | undefined }
  | { readonly kind: "ready"; readonly ix: ModelIndexes }
  | { readonly kind: "error"; readonly message: string };

/** The progress overlay appears only when initialization outlasts this. */
export const SLOW_LOAD_MS = 2000;

/**
 * The tabs: NAVIGATE is the working surface (tree + evidence); CITY is the 3D
 * code city over the same model, full-width — no tree panel there, the city
 * is the navigation surface; the others are the reports, each on its own tab
 * so a report never crowds the navigation. Every report row — and a building
 * selected in the city — leads BACK to Navigate through `reveal`: one
 * selection, five ways of looking at it.
 */
const TABS = ["navigate", "city", "graph", "cycles", "coupling"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Readonly<Record<Tab, string>> = {
  navigate: "Navigate",
  city: "City",
  graph: "Graph",
  cycles: "Cycles",
  coupling: "Coupling",
};

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [slow, setSlow] = useState(false);
  const [tab, setTab] = useState<Tab>("navigate");
  const [graphVisited, setGraphVisited] = useState(false);
  const [cityVisited, setCityVisited] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [selection, setSelection] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hideExternals, setHideExternals] = useState(false);
  const [scrollTo, setScrollTo] = useState<number | undefined>(undefined);
  const loadToken = useRef(0);

  const begin = useCallback(
    async (task: (onProgress: (p: LoadProgress) => void) => Promise<ModelIndexes>, quiet: boolean) => {
      const token = ++loadToken.current;
      const alive = () => loadToken.current === token;
      setPhase({ kind: "loading", progress: undefined });
      try {
        const ix = await task((progress) => {
          if (alive()) setPhase({ kind: "loading", progress });
        });
        if (!alive()) return;
        setExpanded(new Set(ix.fold.roots));
        setSelection(undefined);
        setQuery("");
        setTab("navigate");
        setGraphVisited(false);
        setCityVisited(false);
        setPhase({ kind: "ready", ix });
      } catch (error) {
        if (!alive()) return;
        // Probing the sibling route when nothing is served is not a failure;
        // an artifact that IS there and is wrong always says so.
        if (quiet && error instanceof ArtifactUnavailableError) {
          setPhase({ kind: "idle" });
          return;
        }
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  // The 2-second rule: time the WHOLE initialization, show the bar only when
  // it is exceeded — a fast load never flashes an overlay.
  useEffect(() => {
    if (phase.kind !== "loading") {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  useEffect(() => {
    const src = new URLSearchParams(window.location.search).get("src");
    void begin((on) => loadFromUrl(src ?? "navigator.json", on), src === null);
  }, [begin]);

  useEffect(() => {
    const over = (event: DragEvent) => event.preventDefault();
    const drop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file !== undefined) void begin((on) => loadFromFile(file, on), false);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [begin]);

  const pickFile = useCallback(
    (file: File) => void begin((on) => loadFromFile(file, on), false),
    [begin],
  );

  const ix = phase.kind === "ready" ? phase.ix : undefined;

  /** Select a node from anywhere: jump to Navigate, reveal it, scroll to it. */
  const reveal = useCallback(
    (node: number) => {
      if (ix === undefined) return;
      setSelection(node);
      setExpanded((current) => expandedToReveal(ix.model, ix.fold, current, node));
      setQuery("");
      setScrollTo(node);
      setTab("navigate");
    },
    [ix],
  );

  /**
   * The city's hand-off: a building or district names an entity id, and the
   * navigator resolves it against its OWN nodes (the two artifacts share the
   * ids, nothing else). Unknown — the city was built under another view —
   * returns false, and the city says so instead of pretending.
   */
  const openFromCity = useCallback(
    (target: { readonly id: string }): boolean => {
      if (ix === undefined) return false;
      const node = ix.nodeById.get(target.id);
      if (node === undefined) return false;
      reveal(node);
      return true;
    },
    [ix, reveal],
  );

  const toggle = useCallback((node: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  }, []);

  const stats = useMemo(
    () =>
      ix === undefined
        ? undefined
        : {
            nodes: ix.model.nodes.length,
            deps: ix.model.deps.length,
            cycles: ix.model.reports?.cycles.reduce(
              (sum, report) => sum + report.components.length,
              0,
            ),
          },
    [ix],
  );

  const pickTab = useCallback((next: Tab) => {
    setTab(next);
    if (next === "graph") setGraphVisited(true);
    if (next === "city") setCityVisited(true);
  }, []);

  if (phase.kind === "loading" && !slow) {
    return <div className="app app-blank" />;
  }
  if (phase.kind === "loading") {
    return <ProgressOverlay progress={phase.progress} />;
  }
  if (phase.kind === "idle" || phase.kind === "error") {
    return <Loader error={phase.kind === "error" ? phase.message : undefined} onFile={pickFile} />;
  }
  if (ix === undefined) return null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>{ix.model.corpus.name}</h1>
        <span className="view-badge" title="The view this artifact was built under">
          view {ix.model.view.name}
        </span>
        <span className="header-stats">
          {stats?.nodes.toLocaleString()} nodes · {stats?.deps.toLocaleString()} dependency rows
        </span>
        <nav className="tab-strip" role="tablist" aria-label="Views">
          {TABS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              className={tab === candidate ? "tab tab-on" : "tab"}
              onClick={() => pickTab(candidate)}
            >
              {TAB_LABEL[candidate]}
              {candidate === "cycles" && stats?.cycles !== undefined && stats.cycles > 0 && (
                <span className="tab-count">{stats.cycles}</span>
              )}
            </button>
          ))}
        </nav>
        <label className="header-toggle">
          <input
            type="checkbox"
            checked={!hideExternals}
            onChange={(event) => setHideExternals(!event.target.checked)}
          />
          Show externals
        </label>
      </header>
      <div className="app-body" hidden={tab !== "navigate"}>
        <TreePanel
          ix={ix}
          expanded={expanded}
          selection={selection}
          query={query}
          hideExternals={hideExternals}
          scrollTo={scrollTo}
          onScrolled={() => setScrollTo(undefined)}
          onQuery={setQuery}
          onToggle={toggle}
          onSelect={setSelection}
          onReveal={reveal}
        />
        <DepsView ix={ix} selection={selection} onNavigate={reveal} />
      </div>
      {(cityVisited || tab === "city") && (
        // Mounted on first visit, then kept alive hidden: the city's GPU upload
        // is too expensive to redo on every tab switch; hidden, it only pauses.
        <div className="app-body" hidden={tab !== "city"}>
          <CityTab active={tab === "city"} onOpenInNavigator={openFromCity} />
        </div>
      )}
      {(graphVisited || tab === "graph") && (
        // Mounted on first visit, then kept alive hidden: the fcose layout of
        // a real corpus is too expensive to redo on every tab switch.
        <div className="app-body" hidden={tab !== "graph"}>
          <GraphView
            ix={ix}
            hideExternals={hideExternals}
            active={tab === "graph"}
            selection={selection}
            onSelect={setSelection}
            onReveal={reveal}
          />
        </div>
      )}
      {tab === "cycles" && (
        <div className="app-body">
          <CyclesView ix={ix} onReveal={reveal} />
        </div>
      )}
      {tab === "coupling" && (
        <div className="app-body">
          <CouplingView ix={ix} hideExternals={hideExternals} onReveal={reveal} />
        </div>
      )}
    </div>
  );
}
