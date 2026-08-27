import {
  ARROW_ALPHA_DIMMED,
  ARROW_ALPHA_FOCUS,
  ARROW_ALPHA_MAX,
  ARROW_ALPHA_MIN,
} from "../theme.js";

/** The header's arrow controls, as the decision table reads them. */
export interface ArrowToggles {
  /** Show arcs INTO the selection — who depends on it. */
  readonly fanIn: boolean;
  /** Show arcs OUT of the selection — what it depends on. */
  readonly fanOut: boolean;
  /** Show dependencies on stubs — code the corpus does not declare. */
  readonly externals: boolean;
  /** Show the minimum feedback set — the cycle-breaking cuts — at rest. */
  readonly tangles: boolean;
}

export type ArcRole = "fanIn" | "fanOut" | "feedback" | "hidden";

export interface ArcState {
  readonly role: ArcRole;
  /** 0 for hidden — an arc is HIDDEN, never dimmed-but-lingering. */
  readonly alpha: number;
}

/**
 * ONE decision table for both arc families — type arrows under a selected
 * building and district arrows under a selected district — so the two layers
 * cannot drift apart. Nothing is selected: nothing is drawn, EXCEPT the
 * feedback arcs while the tangles toggle is on — the one resting display,
 * because a tangle is a property of the whole graph, not of a selection. A
 * selection shows exactly its own fan-in/fan-out, direction by hue, weight by
 * alpha; an external arc additionally needs the externals toggle. A feedback
 * arc under the tangles toggle stays in its red role — the offense outranks
 * the direction hue — full-strength when incident to the selection, dimmed
 * (never hidden) otherwise so the tangle stays situated.
 */
interface ArcLike {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly external: boolean;
  readonly feedback: boolean;
}

export function arcState(
  arc: ArcLike,
  selected: string | null,
  toggles: ArrowToggles,
): ArcState {
  if (arc.external && !toggles.externals) return { role: "hidden", alpha: 0 };
  if (arc.feedback && toggles.tangles) {
    if (selected === null) {
      // The resting range: weight still reads as opacity.
      return {
        role: "feedback",
        alpha: ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_MAX - ARROW_ALPHA_MIN),
      };
    }
    const incident = arc.from === selected || arc.to === selected;
    return {
      role: "feedback",
      alpha: incident
        ? ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN)
        : ARROW_ALPHA_DIMMED,
    };
  }
  if (selected === null) return { role: "hidden", alpha: 0 };
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
 * highlights nothing. A feedback arc highlights only when INCIDENT to the
 * selection (resting and dimmed feedback arcs light nobody), and its far end
 * takes the direction the arc actually runs. An element that is both a
 * dependency and a dependent (mutual arcs) shows as fan-in: who-depends-on-it
 * is the rarer, louder fact.
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
    let direction: "fanIn" | "fanOut";
    if (state.role === "feedback") {
      if (arc.from === selected) direction = "fanOut";
      else if (arc.to === selected) direction = "fanIn";
      else continue;
    } else {
      direction = state.role;
    }
    const far = direction === "fanOut" ? arc.to : arc.from;
    if (direction === "fanIn" || !map.has(far)) map.set(far, direction);
  }
  map.set(selected, "origin");
  return map;
}
