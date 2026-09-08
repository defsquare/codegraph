import type { Priceable } from "./priceable.js";

/** `interface extends interface` is inheritance, not implementation. */
export interface Discountable extends Priceable {
  discount(pct: number): number;
}

/** Merged with the declaration above, in the SAME file: one entity, anchored at the first. */
export interface Discountable {
  reason?: string;
}
