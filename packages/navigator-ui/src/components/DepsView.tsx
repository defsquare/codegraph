import { memo, useMemo, useState } from "react";
import type { DepRole, NavigatorModel } from "@codegraph/navigator";
import type { ModelIndexes } from "../model/indexes.js";
import { ancestorsOf } from "../model/indexes.js";
import { DEP_PAGE_SIZE, depPage, depsForSelection, type DepGroup, type MemberGroup } from "../model/grouping.js";

/**
 * The fan-in / fan-out view: what points AT the selected node, and what it
 * points at, sectioned by role with the evidence for every single edge.
 *
 * Nothing is derived here. Roles, carrying members, provenance and anchors all
 * arrive classified in the artifact; this component groups the row indexes and
 * renders them. An inference never looks like a fact — a row whose provenance
 * is not `declared` carries a marked badge (CLAUDE.md invariant 2).
 */

export interface DepsViewProps {
  readonly ix: ModelIndexes;
  readonly selection: number | undefined;
  readonly onNavigate: (node: number) => void;
}

/** What each role means, in the reader's terms — the section subtitles. */
const ROLE_LABEL: Readonly<Record<DepRole, string>> = {
  import: "Imports",
  extends: "Inheritance",
  implements: "Interface implementation",
  embeds: "Embedding",
  usesTrait: "Trait use",
  includesFile: "File include",
  invokes: "Invocations",
  reads: "Field reads",
  writes: "Field writes",
  returnType: "Return type",
  parameterType: "Parameter type",
  localVariableType: "Local variable type",
  fieldType: "Field type",
  typeReference: "Type reference",
};

function nodePath(model: NavigatorModel, node: number): string {
  return ancestorsOf(model, node)
    .map((ancestor) => model.nodes[ancestor]?.name ?? "?")
    .join(" › ");
}

function anchorText(model: NavigatorModel, anchor: readonly [number, number, number]): string {
  const file = model.files[anchor[0]] ?? "?";
  return anchor[1] === anchor[2] ? `${file}:${anchor[1]}` : `${file}:${anchor[1]}–${anchor[2]}`;
}

/**
 * Evidence, one row at a time. A real corpus has 90-character source paths;
 * showing every one in full turns each row into three lines of directory
 * names, so the row shows the file NAME and carries the full path on hover.
 * The header still shows its anchor in full — there is one of it.
 */
function shortAnchor(model: NavigatorModel, anchor: readonly [number, number, number]): string {
  const full = anchorText(model, anchor);
  return full.slice(full.lastIndexOf("/") + 1);
}

interface RowProps {
  readonly ix: ModelIndexes;
  readonly row: number;
  /** Which end is the counterpart: the far side of the selected node. */
  readonly direction: "incoming" | "outgoing";
  readonly onNavigate: (node: number) => void;
}

const DepRowLine = memo(function DepRowLine({ ix, row, direction, onNavigate }: RowProps) {
  const dep = ix.model.deps[row];
  if (dep === undefined) return null;
  const counterpart = direction === "incoming" ? dep.from : dep.to;
  const counterpartMember = direction === "incoming" ? dep.member : dep.toMember;
  const nearMember = direction === "incoming" ? dep.toMember : dep.member;
  const entry = ix.model.nodes[counterpart];
  if (entry === undefined) return null;
  const memberEntry = counterpartMember === undefined ? undefined : ix.model.nodes[counterpartMember];
  const nearEntry = nearMember === undefined ? undefined : ix.model.nodes[nearMember];
  const inferred = dep.provenance !== "declared";
  return (
    <li className="dep-row">
      <button type="button" className="counterpart" onClick={() => onNavigate(counterpart)}>
        <span className={entry.isStub ? "counterpart-name stub" : "counterpart-name"}>
          {entry.name}
        </span>
        {memberEntry !== undefined && (
          <span className="counterpart-member">{memberEntry.signature ?? memberEntry.name}</span>
        )}
      </button>
      <span className="dep-meta">
        {nearEntry !== undefined && (
          <span
            className="via"
            title={`${
              direction === "incoming"
                ? "The member of the selected node this edge lands on"
                : "The member of the selected node that carries this edge"
            }: ${nearEntry.signature ?? nearEntry.name}`}
          >
            {direction === "incoming" ? "on" : "via"} {nearEntry.signature ?? nearEntry.name}
          </span>
        )}
        {dep.detail !== undefined && <span className="detail">{dep.detail}</span>}
        {inferred && (
          <span className="provenance" title="An inference, not a declared fact">
            {dep.provenance}
          </span>
        )}
        <span className="anchor" title={anchorText(ix.model, dep.anchor)}>
          {shortAnchor(ix.model, dep.anchor)}
        </span>
      </span>
      <span className="dep-path">{nodePath(ix.model, counterpart)}</span>
    </li>
  );
});

/**
 * One page of a section's rows, plus the button that reveals the next. The
 * remainder is stated in full: a bounded DOM must never read as a bounded
 * fact (a section whose rows are all mounted shows no footer at all).
 */
function MoreRows({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  if (remaining <= 0) return null;
  return (
    <li className="dep-more">
      <button type="button" onClick={onMore}>
        Show {Math.min(remaining, DEP_PAGE_SIZE).toLocaleString()} more
      </button>
      <span className="dep-more-note">{remaining.toLocaleString()} not shown</span>
    </li>
  );
}

function Section({
  ix,
  group,
  direction,
  onNavigate,
}: {
  ix: ModelIndexes;
  group: DepGroup;
  direction: "incoming" | "outgoing";
  onNavigate: (node: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const [pages, setPages] = useState(1);
  const page = depPage(group.rows.length, pages);
  return (
    <section className="dep-section">
      <button type="button" className="dep-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="dep-role">{ROLE_LABEL[group.role]}</span>
        <span className="dep-count">{group.rows.length.toLocaleString()}</span>
      </button>
      {open && (
        <ul className="dep-rows">
          {group.rows.slice(0, page.shown).map((row) => (
            <DepRowLine key={row} ix={ix} row={row} direction={direction} onNavigate={onNavigate} />
          ))}
          <MoreRows remaining={page.remaining} onMore={() => setPages(pages + 1)} />
        </ul>
      )}
    </section>
  );
}

function MemberSection({
  ix,
  group,
  ownLabel,
  onNavigate,
}: {
  ix: ModelIndexes;
  group: MemberGroup;
  /** What to call the rows the selected node carries itself. */
  ownLabel: string;
  onNavigate: (node: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState(1);
  const page = depPage(group.rows.length, pages);
  const member = group.member === undefined ? undefined : ix.model.nodes[group.member];
  return (
    <section className="dep-section">
      <button type="button" className="dep-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="dep-role" title={member === undefined ? ownLabel : (member.signature ?? member.name)}>
          {member === undefined ? ownLabel : (member.signature ?? member.name)}
        </span>
        <span className="dep-count">{group.rows.length.toLocaleString()}</span>
      </button>
      {open && (
        <ul className="dep-rows">
          {group.rows.slice(0, page.shown).map((row) => (
            <DepRowLine key={row} ix={ix} row={row} direction="outgoing" onNavigate={onNavigate} />
          ))}
          <MoreRows remaining={page.remaining} onMore={() => setPages(pages + 1)} />
        </ul>
      )}
    </section>
  );
}

type Pane = "fan" | "byMember";

export function DepsView({ ix, selection, onNavigate }: DepsViewProps) {
  const [pane, setPane] = useState<Pane>("fan");
  const deps = useMemo(
    () => (selection === undefined ? undefined : depsForSelection(ix, selection)),
    [ix, selection],
  );

  if (selection === undefined || deps === undefined) {
    return (
      <main className="deps-view deps-empty">
        <p>Pick a module, type or operation in the tree to see what depends on it, and what it depends on.</p>
      </main>
    );
  }

  const node = ix.model.nodes[selection];
  if (node === undefined) return null;
  const incomingTotal = deps.incoming.reduce((total, group) => total + group.rows.length, 0);
  const outgoingTotal = deps.outgoing.reduce((total, group) => total + group.rows.length, 0);
  // Only worth a pane when some row is actually carried BY a member: a
  // module's imports are declared by the module itself, so bucketing them by
  // member would offer one group holding everything.
  const showByMember = deps.outgoingByMember.some((group) => group.member !== undefined);
  const ownLabel = node.category === "module" ? "The module itself" : "The type itself";

  return (
    <main className="deps-view">
      <header className="deps-head">
        <p className="deps-path">{nodePath(ix.model, selection)}</p>
        <h2>
          {node.signature ?? node.name}
          <span className="kind-badge">{node.kind}</span>
          {node.isStub && <span className="stub-badge">external</span>}
        </h2>
        <div className="deps-facts">
          {node.metrics !== undefined && (
            <span>
              fan-in <strong>{node.metrics.fanIn}</strong> · fan-out <strong>{node.metrics.fanOut}</strong>
              <span className="facts-note"> distinct counterparts</span>
            </span>
          )}
          {node.anchor !== undefined && (
            <span className="anchor">{anchorText(ix.model, node.anchor)}</span>
          )}
        </div>
        {showByMember && (
          <nav className="pane-tabs">
            <button
              type="button"
              className={pane === "fan" ? "active" : ""}
              onClick={() => setPane("fan")}
            >
              By direction
            </button>
            <button
              type="button"
              className={pane === "byMember" ? "active" : ""}
              onClick={() => setPane("byMember")}
            >
              By operation
            </button>
          </nav>
        )}
      </header>

      {pane === "fan" || !showByMember ? (
        <div className="fan-panes">
          <div className="fan-pane">
            <h3 className="fan-title fan-in">
              Incoming <span className="fan-total">{incomingTotal}</span>
            </h3>
            {deps.incoming.length === 0 ? (
              <p className="fan-none">Nothing in this corpus depends on it, under this view.</p>
            ) : (
              deps.incoming.map((group) => (
                <Section
                  key={group.role}
                  ix={ix}
                  group={group}
                  direction="incoming"
                  onNavigate={onNavigate}
                />
              ))
            )}
          </div>
          <div className="fan-pane">
            <h3 className="fan-title fan-out">
              Outgoing <span className="fan-total">{outgoingTotal}</span>
            </h3>
            {deps.outgoing.length === 0 ? (
              <p className="fan-none">It depends on nothing, under this view.</p>
            ) : (
              deps.outgoing.map((group) => (
                <Section
                  key={group.role}
                  ix={ix}
                  group={group}
                  direction="outgoing"
                  onNavigate={onNavigate}
                />
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="member-pane">
          <h3 className="fan-title fan-out">
            Outgoing, by the member that carries it <span className="fan-total">{outgoingTotal}</span>
          </h3>
          {deps.outgoingByMember.map((group) => (
            <MemberSection
              key={group.member ?? -1}
              ix={ix}
              group={group}
              ownLabel={ownLabel}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </main>
  );
}
