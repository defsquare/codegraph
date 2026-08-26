import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import type { NavNode } from "@codegraph/navigator";
import type { ModelIndexes } from "../model/indexes.js";
import { ancestorsOf } from "../model/indexes.js";
import { visibleRows, type TreeRow } from "../model/flatten.js";
import { searchNodes } from "../model/search.js";

/**
 * The tree, virtualized: only the rows in the viewport mount, so a 240k-node
 * corpus scrolls at the same cost as a toy. The flat row array is derived from
 * (roots, expanded, hideExternals) by a pure function and memoized; a search
 * query swaps the tree for a capped match list with breadcrumb paths.
 */
const ROW_HEIGHT = 26;

export interface TreePanelProps {
  readonly ix: ModelIndexes;
  readonly expanded: ReadonlySet<number>;
  readonly selection: number | undefined;
  readonly query: string;
  readonly hideExternals: boolean;
  /** A node the panel must scroll into view once, then report done. */
  readonly scrollTo: number | undefined;
  readonly onScrolled: () => void;
  readonly onQuery: (query: string) => void;
  readonly onToggle: (node: number) => void;
  readonly onSelect: (node: number) => void;
  /** Select AND reveal — used from search results. */
  readonly onReveal: (node: number) => void;
}

/** Category marks: one glyph each, letterforms rather than colors — color in
 * this app is reserved for direction, provenance and selection. */
const GLYPH: Readonly<Record<NavNode["category"], string>> = {
  module: "M",
  type: "T",
  operation: "ƒ",
  attribute: "·",
};

function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

interface RowData {
  readonly ix: ModelIndexes;
  readonly rows: readonly TreeRow[];
  readonly selection: number | undefined;
  readonly expanded: ReadonlySet<number>;
  readonly onToggle: (node: number) => void;
  readonly onSelect: (node: number) => void;
}

const Row = memo(function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const row = data.rows[index];
  if (row === undefined) return null;
  const node = data.ix.model.nodes[row.node];
  if (node === undefined) return null;
  const isSelected = data.selection === row.node;
  const isOpen = data.expanded.has(row.node);
  return (
    <div
      style={style}
      className={`tree-row${isSelected ? " selected" : ""}${node.isStub ? " stub" : ""}`}
      onClick={() => data.onSelect(row.node)}
    >
      <span className="tree-indent" style={{ width: row.depth * 14 }} />
      {row.expandable ? (
        <button
          type="button"
          className="twisty"
          aria-label={isOpen ? "Collapse" : "Expand"}
          aria-expanded={isOpen}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle(row.node);
          }}
        >
          {isOpen ? "▾" : "▸"}
        </button>
      ) : (
        <span className="twisty twisty-leaf" />
      )}
      <span className={`glyph glyph-${node.category}`} title={node.kind}>
        {GLYPH[node.category]}
      </span>
      <span className="tree-name" title={node.signature ?? node.name}>
        {node.category === "operation" ? (node.signature ?? node.name) : node.name}
      </span>
    </div>
  );
});

const MatchRow = memo(function MatchRow({ index, style, data }: ListChildComponentProps<MatchData>) {
  const node = data.matches[index];
  if (node === undefined) return null;
  const entry = data.ix.model.nodes[node];
  if (entry === undefined) return null;
  const path = ancestorsOf(data.ix.model, node)
    .map((ancestor) => data.ix.model.nodes[ancestor]?.name ?? "?")
    .join(" › ");
  return (
    <div
      style={style}
      className={`tree-row match-row${data.selection === node ? " selected" : ""}${entry.isStub ? " stub" : ""}`}
      onClick={() => data.onReveal(node)}
    >
      <span className={`glyph glyph-${entry.category}`} title={entry.kind}>
        {GLYPH[entry.category]}
      </span>
      <span className="match-text">
        <span className="tree-name">{entry.signature ?? entry.name}</span>
        {path.length > 0 && <span className="match-path">{path}</span>}
      </span>
    </div>
  );
});

interface MatchData {
  readonly ix: ModelIndexes;
  readonly matches: readonly number[];
  readonly selection: number | undefined;
  readonly onReveal: (node: number) => void;
}

export function TreePanel(props: TreePanelProps) {
  const { ix, expanded, selection, query, hideExternals, scrollTo, onScrolled } = props;
  const [containerRef, height] = useElementHeight<HTMLDivElement>();
  const listRef = useRef<FixedSizeList>(null);

  const rows = useMemo(
    () => visibleRows(ix.model, expanded, { hideExternals }),
    [ix, expanded, hideExternals],
  );
  const search = useMemo(() => searchNodes(ix.searchKeys, query), [ix, query]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (scrollTo === undefined || searching) return;
    const index = rows.findIndex((row) => row.node === scrollTo);
    if (index >= 0) listRef.current?.scrollToItem(index, "smart");
    onScrolled();
  }, [scrollTo, rows, searching, onScrolled]);

  const rowData: RowData = useMemo(
    () => ({
      ix,
      rows,
      selection,
      expanded,
      onToggle: props.onToggle,
      onSelect: props.onSelect,
    }),
    [ix, rows, selection, expanded, props.onToggle, props.onSelect],
  );
  const matchData: MatchData = useMemo(
    () => ({ ix, matches: search.matches, selection, onReveal: props.onReveal }),
    [ix, search.matches, selection, props.onReveal],
  );

  return (
    <aside className="tree-panel">
      <div className="search-box">
        <input
          type="search"
          placeholder="Search names and signatures"
          value={query}
          onChange={(event) => props.onQuery(event.target.value)}
          aria-label="Search the model"
        />
      </div>
      {searching && (
        <p className="search-note">
          {search.matches.length === 0
            ? "No names match."
            : search.truncated
              ? `First ${search.matches.length} matches — keep typing to narrow.`
              : `${search.matches.length} ${search.matches.length === 1 ? "match" : "matches"}.`}
        </p>
      )}
      <div className="tree-list" ref={containerRef}>
        {searching ? (
          <FixedSizeList
            height={height}
            width="100%"
            itemCount={search.matches.length}
            itemSize={ROW_HEIGHT + 12}
            itemData={matchData}
            overscanCount={8}
          >
            {MatchRow}
          </FixedSizeList>
        ) : (
          <FixedSizeList
            ref={listRef}
            height={height}
            width="100%"
            itemCount={rows.length}
            itemSize={ROW_HEIGHT}
            itemData={rowData}
            overscanCount={12}
          >
            {Row}
          </FixedSizeList>
        )}
      </div>
    </aside>
  );
}
