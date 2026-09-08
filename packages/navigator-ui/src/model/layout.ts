import type { GraphMode } from "./graph.js";

/**
 * THE LAYOUT BUDGET — what makes opening the Graph tab affordable.
 *
 * MEASURED, on the modules drawing of a 63k-node corpus (Chrome, M-series):
 *
 *     nodes  links   fcose "default"   fcose "proof"
 *        80    384          134 ms          271 ms
 *       150  1,013          297 ms          873 ms
 *       300  2,512        1,299 ms        3,891 ms
 *       400  3,609        3,382 ms
 *       600  5,918       16,823 ms
 *     1,200 12,395      ~122,000 ms   (the frozen tab this replaces)
 *
 * Two facts the numbers settle, both contrary to the obvious guesses:
 *
 *   - `numIter` DOES NOT BOUND THE COST. fcose runs a tree-growth and an
 *     after-growth phase past its iteration limit; at 1,200 nodes `numIter:
 *     100` and `numIter: 2500` both cost about two minutes. The only thing
 *     that bounds the layout is HOW MUCH IS DRAWN.
 *   - The curve is worse than quadratic past ~400 nodes. So the drawing size
 *     is the knob that matters, and it belongs to the reader (`GRAPH_SIZES`),
 *     with a default that lands near a second.
 *
 * Quality is chosen the same way: proof is a full-sample spectral solve, ~3x
 * default, worth its cost only on a drawing small enough to still be quick.
 */

/** Drawing sizes the reader can pick, smallest first; the DEFAULT is second. */
export const GRAPH_SIZES = [150, 300, 600, 1200] as const;

/** Above this the drawing takes visibly longer than a beat — the reader is warned. */
export const GRAPH_SIZE_SLOW = 300;

/** Above this node count proof quality stops being worth roughly 3x the time. */
export const PROOF_MAX_NODES = 150;

/** fcose's own default; nothing is gained by asking for more. */
export const MAX_ITERATIONS = 2500;

/**
 * SEPARATION. fcose's stock repulsion is tuned for graphs whose nodes are a
 * few pixels wide; these are 26-80px discs on a densely-linked graph, and at
 * the default the drawing collapsed into one solid blob of overlapping circles
 * at EVERY size — 150 nodes was as unreadable as 1,200. Raising repulsion and
 * the ideal edge length against the node scale, and slackening gravity so the
 * periphery is not pulled back into the core, is what makes the drawing show
 * its structure. It is also FASTER: separated nodes share fewer repulsion grid
 * cells (measured 150 nodes / 1,026 links: 1,020 ms → 279 ms).
 */
export interface LayoutBudget {
  readonly name: "fcose";
  readonly quality: "draft" | "default" | "proof";
  readonly numIter: number;
  /** Always false: an animated layout of a corpus drawing is a slideshow. */
  readonly animate: false;
  readonly randomize: true;
  readonly nodeSeparation: number;
  readonly nodeRepulsion: number;
  readonly gravity: number;
  readonly idealEdgeLength: number;
  readonly nestingFactor?: number;
  readonly packComponents?: boolean;
}

export function graphLayoutBudget(mode: GraphMode, nodes: number): LayoutBudget {
  const quality = nodes <= PROOF_MAX_NODES ? "proof" : "default";
  const common = {
    name: "fcose",
    quality,
    numIter: MAX_ITERATIONS,
    animate: false,
    randomize: true,
  } as const;
  // Modules are the big discs (26-80px); types are half that, and nest inside
  // module compounds, so they need proportionally less room.
  return mode === "modules"
    ? { ...common, nodeSeparation: 110, nodeRepulsion: 200_000, gravity: 0.1, idealEdgeLength: 260 }
    : {
        ...common,
        nodeSeparation: 70,
        nodeRepulsion: 80_000,
        gravity: 0.15,
        idealEdgeLength: 140,
        nestingFactor: 0.1,
        packComponents: true,
      };
}
