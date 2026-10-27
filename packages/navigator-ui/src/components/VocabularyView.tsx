import { useEffect, useMemo, useState } from "react";
import type { TermClass } from "@codegraph/vocabulary";
import { CLOUD_DEFAULTS, MONOSPACE_LINE, layoutCloud, monospaceMeasure, type Measure } from "@codegraph/vocabulary/cloud";
import type { ModelIndexes } from "../model/indexes.js";
import { carrierNode, cloudWords, indexVocabulary, scopeChain, scopeForNode, wordRows, type WordRow } from "../model/words.js";
import { TERM_CLASSES, createCarriersLoader, loadVocabulary, type Carriers, type VocabularyLoad } from "../vocabulary.js";

/**
 * The Vocabulary tab (PLAN.md §20.2): the words the selected scope's names
 * are made of — the corpus until a module or a type is selected, then that
 * scope; a member shows its type — as a cloud and as a table, and for one
 * word, the names that carry it.
 *
 * MEANING CONTROLS APPEARANCE, as on the CLI's `--svg`: a word's size is its
 * weight, on the square root; its colour is its class and nothing else —
 * domain in paper, technical dimmed, keyword and short faint. The layout is
 * the package's own function, measured with this page's font, so the cloud is
 * the one `codegraph vocabulary --svg` draws up to the face. The legend says
 * what was counted: a cloud without it is a picture, not a fact.
 *
 * Every number is the artifact's; the carriers are the server's lookup, and a
 * page served without one (the app daemon, a static host) shows the counts
 * and says why there is no evidence.
 */

/** The CLI's `--top` default. */
const TOP = 40;
const TOP_MAX = 200;
/** Table rows at once; the cloud's top N is what the slider moves. */
const ROW_CAP = 500;
const LOADER = createCarriersLoader();

export interface VocabularyViewProps {
  readonly ix: ModelIndexes;
  /** The Navigate selection: the scope follows it. */
  readonly selection: number | undefined;
  /** Select a scope's node — or none, the corpus — without leaving the tab. */
  readonly onSelect: (node: number | undefined) => void;
  /** Select a node and show it in Navigate. */
  readonly onReveal: (node: number) => void;
}

/** The page's monospace face, measured: what the SVG text below is set in. */
function pageMeasure(): Measure {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) return monospaceMeasure;
  const family = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
  return (text, size) => {
    context.font = `${size}px ${family}`;
    return { width: context.measureText(text).width, height: MONOSPACE_LINE * size };
  };
}

const plural = (count: number, noun: string, nouns = `${noun}s`): string => `${count.toLocaleString()} ${count === 1 ? noun : nouns}`;

/** The anchor's file by its last two segments — the full path is the tooltip. */
function shortPath(file: string): string {
  const parts = file.split("/");
  return parts.length <= 2 ? file : `…/${parts.slice(-2).join("/")}`;
}

export function VocabularyView({ ix, selection, onSelect, onReveal }: VocabularyViewProps) {
  const [load, setLoad] = useState<VocabularyLoad | undefined>(undefined);
  const [classes, setClasses] = useState<ReadonlySet<TermClass>>(new Set(["domain"]));
  const [top, setTop] = useState(TOP);
  const [picked, setPicked] = useState<{ readonly scope: number; readonly row: WordRow } | undefined>(undefined);
  const [carriers, setCarriers] = useState<{ readonly key: string; readonly answer: Carriers } | undefined>(undefined);
  const measure = useMemo(pageMeasure, []);

  // A new navigator (the app daemon's next job) comes with a new vocabulary.
  useEffect(() => {
    let current = true;
    setLoad(undefined);
    void loadVocabulary().then((result) => {
      if (current) setLoad(result);
    });
    return () => {
      current = false;
    };
  }, [ix]);

  const vocabulary = useMemo(() => (load?.status === "ready" ? indexVocabulary(load.artifact) : undefined), [load]);
  const scope = vocabulary === undefined ? 0 : scopeForNode(ix, vocabulary, selection);
  const rows = useMemo(
    () => (vocabulary === undefined ? [] : wordRows(vocabulary.artifact, scope, classes)),
    [vocabulary, scope, classes],
  );
  const layout = useMemo(() => layoutCloud(cloudWords(rows, top), { measure }), [rows, top, measure]);
  const pick = picked?.scope === scope ? picked.row : undefined;
  const scopeId = vocabulary?.artifact.scopes[scope]?.id;
  const pickKey = pick === undefined ? undefined : `${scopeId ?? ""}\u0000${pick.text}\u0000${pick.class}`;

  useEffect(() => {
    if (pick === undefined || pickKey === undefined) return;
    let current = true;
    void LOADER.load({ scope: scopeId, term: pick.text, class: pick.class }).then((answer) => {
      if (current) setCarriers({ key: pickKey, answer });
    });
    return () => {
      current = false;
    };
  }, [pick, pickKey, scopeId]);

  if (load === undefined) return <main className="report-view vocabulary-view" />;
  if (load.status === "absent") {
    return (
      <main className="report-view vocabulary-view">
        <p className="report-empty">
          No vocabulary is served with this page. <code>codegraph serve model.jsonl</code> builds one beside the navigator;{" "}
          <code>codegraph vocabulary model.jsonl --svg cloud.svg</code> draws a scope's cloud on its own.
        </p>
      </main>
    );
  }
  if (load.status === "error" || vocabulary === undefined) {
    return (
      <main className="report-view vocabulary-view">
        <p className="report-empty">{load.status === "error" ? load.message : ""}</p>
      </main>
    );
  }

  const { artifact } = vocabulary;
  const here = artifact.scopes[scope];
  const chain = scopeChain(artifact, scope);
  const shown = layout.words.length;
  const what = classes.size === TERM_CLASSES.length ? "all classes" : TERM_CLASSES.filter((cls) => classes.has(cls)).join(" + ");
  const toggle = (cls: TermClass) => {
    const next = new Set(classes);
    if (next.has(cls)) next.delete(cls);
    else next.add(cls);
    if (next.size > 0) setClasses(next);
  };
  const choose = (row: WordRow) => setPicked(pick?.term === row.term ? undefined : { scope, row });
  const answer = carriers !== undefined && carriers.key === pickKey ? carriers.answer : undefined;

  return (
    <main className="vocabulary-view">
      <div className="report-toolbar vocabulary-toolbar">
        <nav className="scope-chain" aria-label="Scope">
          {chain.map((index, position) => {
            const link = artifact.scopes[index];
            if (link === undefined) return null;
            const node = link.id === undefined ? undefined : ix.nodeById.get(link.id);
            const last = position === chain.length - 1;
            return (
              <span key={index} className="scope-link">
                {position > 0 && <span className="scope-sep">›</span>}
                <button
                  type="button"
                  className={last ? "scope-here" : undefined}
                  disabled={last}
                  title={link.level === "corpus" ? "The whole corpus: clears the selection" : `Select ${link.level} ${link.name}`}
                  onClick={() => onSelect(node)}
                >
                  <span className="scope-level">{link.level}</span> {link.name}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="seg" role="group" aria-label="Word classes">
          {TERM_CLASSES.map((cls) => (
            <button
              key={cls}
              type="button"
              aria-pressed={classes.has(cls)}
              className={classes.has(cls) ? `seg-on chip-${cls}` : `chip-${cls}`}
              onClick={() => toggle(cls)}
            >
              {cls}
            </button>
          ))}
        </div>
        <label className="top-slider">
          top
          <input type="range" min={5} max={TOP_MAX} step={5} value={top} onChange={(event) => setTop(Number(event.target.value))} />
          <span className="top-value">{top}</span>
        </label>
        <span className="report-summary">
          {plural(here?.entities ?? 0, "entity", "entities")} · {plural(here?.distinctDomain ?? 0, "domain term")} of {plural(here?.distinct ?? 0, "term")}
        </span>
      </div>

      <div className="vocabulary-body">
        <section className="cloud-pane" aria-label="Word cloud">
          {shown === 0 ? (
            <p className="report-empty">This scope speaks no {what} word.</p>
          ) : (
            <svg
              className="cloud"
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              style={{ maxWidth: layout.width * 1.5, maxHeight: layout.height * 1.5 }}
              role="img"
              aria-label={`${here?.level ?? ""} ${here?.name ?? ""}: ${shown} words`}
            >
              {pick !== undefined &&
                layout.words
                  .filter((word) => word.text === pick.text && word.class === pick.class)
                  .map((word) => (
                    <rect
                      key="pick"
                      className="cloud-pick"
                      x={word.x - word.width / 2 - 2}
                      y={word.y - word.height / 2}
                      width={word.width + 4}
                      height={word.height}
                      rx={3}
                    />
                  ))}
              {layout.words.map((word) => {
                const row = rows.find((candidate) => candidate.text === word.text && candidate.class === word.class);
                return (
                  <text
                    key={`${word.text}/${word.class}`}
                    className={`cloud-word cloud-${word.class}`}
                    x={word.x}
                    y={word.y}
                    fontSize={word.size}
                    role="button"
                    tabIndex={0}
                    onClick={() => row !== undefined && choose(row)}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && row !== undefined) {
                        event.preventDefault();
                        choose(row);
                      }
                    }}
                  >
                    <title>
                      {`${word.text} (${word.class}) — weight ${word.weight}` +
                        (row === undefined ? "" : `, ${plural(row.occurrences, "occurrence")}, ${plural(row.carriers, "carrier")}`)}
                    </title>
                    {word.text}
                  </text>
                );
              })}
            </svg>
          )}
          <footer className="cloud-legend">
            <p>
              {here?.level} {here?.name} · {what}:{" "}
              {rows.length === 0
                ? "no term"
                : `${shown === rows.length ? plural(shown, "term") : `${shown} of ${plural(rows.length, "term")}`} by weight, size on √weight`}
            </p>
            <p>
              weights{" "}
              {Object.entries(artifact.weights)
                .map(([key, value]) => `${key} ${value}`)
                .join(" · ")}
            </p>
            <p>
              view {artifact.view.name} · technical: {plural(artifact.technical.words, "shared word")} (sha256{" "}
              {artifact.technical.sha256.slice(0, 12)}) + each language's own · {CLOUD_DEFAULTS.minSize}–{CLOUD_DEFAULTS.maxSize} px
            </p>
          </footer>
        </section>

        <aside className="vocabulary-aside">
          {pick !== undefined && (
            <section className="carriers" aria-label={`Carriers of ${pick.text}`}>
              <header className="carriers-head">
                <h2>
                  <span className={`cloud-${pick.class}`}>{pick.text}</span> in {here?.level} {here?.name}
                </h2>
                <span className="report-summary">
                  weight {pick.weight} · {plural(pick.occurrences, "occurrence")} · {plural(pick.carriers, "carrier")}
                </span>
                <button type="button" className="report-clear" title="Close" onClick={() => setPicked(undefined)}>
                  ×
                </button>
              </header>
              <CarrierList ix={ix} answer={answer} onReveal={onReveal} />
            </section>
          )}
          <table className="coupling-table words-table">
            <thead>
              <tr>
                <th scope="col">Term</th>
                <th scope="col" className="num" title="The sum of the role weights of the names that say it">
                  Weight
                </th>
                <th scope="col" className="num" title="How many times the names say it">
                  Occ.
                </th>
                <th scope="col" className="num" title="How many distinct names say it">
                  Carriers
                </th>
                <th scope="col" className="num" title="How many modules, and types, of the corpus speak it">
                  Spread
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, ROW_CAP).map((row) => (
                <tr key={row.term} className={pick?.term === row.term ? "selected" : undefined}>
                  <td>
                    <button type="button" className={`word-button cloud-${row.class}`} onClick={() => choose(row)}>
                      {row.text}
                    </button>
                  </td>
                  <td className="num">{row.weight}</td>
                  <td className="num">{row.occurrences}</td>
                  <td className="num">{row.carriers}</td>
                  <td className="num spread" title={`${plural(row.modules, "module")}, ${plural(row.types, "type")}`}>
                    {row.modules} m · {row.types} t
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > ROW_CAP && <p className="report-summary">top {ROW_CAP} of {rows.length.toLocaleString()}</p>}
        </aside>
      </div>
    </main>
  );
}

function CarrierList({
  ix,
  answer,
  onReveal,
}: {
  readonly ix: ModelIndexes;
  readonly answer: Carriers | undefined;
  readonly onReveal: (node: number) => void;
}) {
  if (answer === undefined) return <p className="report-summary">Asking the server…</p>;
  if (answer.status === "none") {
    return (
      <p className="report-summary">
        The names behind a word are a lookup of <code>codegraph serve</code>, over the model it holds; this page has none.
      </p>
    );
  }
  if (answer.status === "unknown") {
    return <p className="report-summary">The server does not know this word here: it was built from another model.</p>;
  }
  return (
    <>
      <ul className="carrier-list">
        {answer.carriers.map((carrier, index) => {
          const node = carrierNode(ix, carrier);
          const line = carrier.anchor?.span[0];
          return (
            <li key={`${carrier.id ?? carrier.owner ?? ""}#${index}`}>
              <button
                type="button"
                className="counterpart"
                disabled={node === undefined}
                title={node === undefined ? "Not a node of this navigator" : carrier.id === undefined ? "Show its type in Navigate" : "Show in Navigate"}
                onClick={() => node !== undefined && onReveal(node)}
              >
                <span className="counterpart-name">{carrier.name}</span>
                <span className="counterpart-member">
                  {carrier.kind} · {carrier.role}
                  {carrier.id === undefined && node !== undefined ? ` in ${ix.model.nodes[node]?.name ?? ""}` : ""}
                </span>
              </button>
              <span className="carrier-weight">+{carrier.weight}</span>
              {carrier.anchor !== undefined && (
                <span className="dep-path carrier-where" title={`${carrier.anchor.file}:${line ?? ""}`}>
                  {shortPath(carrier.anchor.file)}:{line}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {answer.total > answer.carriers.length && (
        <p className="report-summary">
          the {answer.carriers.length} heaviest of {answer.total.toLocaleString()}
        </p>
      )}
    </>
  );
}
