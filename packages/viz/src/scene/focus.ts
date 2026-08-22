import {
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
  /** With nothing selected, show every arc as a resting overview. */
  readonly showAll: boolean;
}

export type ArcRole = "fanIn" | "fanOut" | "resting" | "hidden";

export interface ArcState {
  readonly role: ArcRole;
  /** 0 for hidden — an arc is HIDDEN, never dimmed-but-lingering. */
  readonly alpha: number;
}

/**
 * ONE decision table for both arc families — type arrows under a selected
 * building and district arrows under a selected district — so the two layers
 * cannot drift apart. The resting state is hidden: the city draws no
 * dependency it was not asked for, and a selection shows exactly its own
 * fan-in/fan-out, direction by hue, weight by alpha.
 */
export function arcState(
  arc: { readonly from: string; readonly to: string; readonly weight: number },
  selected: string | null,
  toggles: ArrowToggles,
): ArcState {
  if (selected === null) {
    return toggles.showAll
      ? {
          role: "resting",
          alpha: ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_MAX - ARROW_ALPHA_MIN),
        }
      : { role: "hidden", alpha: 0 };
  }
  const isOut = arc.from === selected && toggles.fanOut;
  const isIn = arc.to === selected && toggles.fanIn;
  if (!isOut && !isIn) return { role: "hidden", alpha: 0 };
  return {
    role: isOut ? "fanOut" : "fanIn",
    alpha: ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN),
  };
}
