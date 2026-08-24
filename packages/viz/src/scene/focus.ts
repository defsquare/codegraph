import { ARROW_ALPHA_FOCUS, ARROW_ALPHA_MIN } from "../theme.js";

/** The header's arrow controls, as the decision table reads them. */
export interface ArrowToggles {
  /** Show arcs INTO the selection — who depends on it. */
  readonly fanIn: boolean;
  /** Show arcs OUT of the selection — what it depends on. */
  readonly fanOut: boolean;
  /** Show dependencies on stubs — code the corpus does not declare. */
  readonly externals: boolean;
}

export type ArcRole = "fanIn" | "fanOut" | "hidden";

export interface ArcState {
  readonly role: ArcRole;
  /** 0 for hidden — an arc is HIDDEN, never dimmed-but-lingering. */
  readonly alpha: number;
}

/**
 * ONE decision table for both arc families — type arrows under a selected
 * building and district arrows under a selected district — so the two layers
 * cannot drift apart. Nothing is selected: nothing is drawn. A selection
 * shows exactly its own fan-in/fan-out, direction by hue, weight by alpha;
 * an external arc additionally needs the externals toggle.
 */
interface ArcLike {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly external: boolean;
}

export function arcState(
  arc: ArcLike,
  selected: string | null,
  toggles: ArrowToggles,
): ArcState {
  if (selected === null) return { role: "hidden", alpha: 0 };
  if (arc.external && !toggles.externals) return { role: "hidden", alpha: 0 };
  const isOut = arc.from === selected && toggles.fanOut;
  const isIn = arc.to === selected && toggles.fanIn;
  if (!isOut && !isIn) return { role: "hidden", alpha: 0 };
  return {
    role: isOut ? "fanOut" : "fanIn",
    alpha: ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN),
  };
}

export type HighlightRole = "origin" | "fanIn" | "fanOut";

/**
 * Which elements light up under a selection: the selection itself as `origin`,
 * and the FAR end of every arc the decision table draws, in that arc's
 * direction hue. Built on `arcState`, so a highlight can never point at an arc
 * that is not on screen — a toggled-off direction or a hidden external arc
 * highlights nothing. An element that is both a dependency and a dependent
 * (mutual arcs) shows as fan-in: who-depends-on-it is the rarer, louder fact.
 */
export function highlightMap(
  arcs: readonly ArcLike[],
  selected: string | null,
  toggles: ArrowToggles,
): ReadonlyMap<string, HighlightRole> {
  const map = new Map<string, HighlightRole>();
  if (selected === null) return map;
  for (const arc of arcs) {
    const state = arcState(arc, selected, toggles);
    if (state.role === "hidden") continue;
    const far = state.role === "fanOut" ? arc.to : arc.from;
    if (state.role === "fanIn" || !map.has(far)) map.set(far, state.role);
  }
  map.set(selected, "origin");
  return map;
}
