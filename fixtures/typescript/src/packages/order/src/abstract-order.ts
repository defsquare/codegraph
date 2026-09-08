import type { Discountable } from "./discountable.js";

/** Shared state for every kind of order. */
export abstract class AbstractOrder implements Discountable {
  protected total = 0;

  constructor(readonly reference: string) {}

  abstract discount(pct: number): number;

  price(): number {
    return this.total;
  }
}
