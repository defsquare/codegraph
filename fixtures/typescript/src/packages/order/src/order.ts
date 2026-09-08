import { applyTax } from "@acme/pricing";
import { Channel } from "@order/channel";
import { AbstractOrder } from "./abstract-order.js";
import type { Cents } from "./money.js";

/** A customer order. */
export class Order extends AbstractOrder {
  /** A compile-time constant: the initializer folds across the arithmetic. */
  static readonly MAX_LINES = 4 * 25;

  private channel: Channel;

  constructor(reference: string, channel: Channel = Channel.Web) {
    super(reference);
    this.channel = channel;
  }

  discount(pct: number): number {
    this.total -= pct;
    return this.total;
  }

  /** A static beside an instance member of the SAME name: `#static` keeps them apart. */
  static parse(text: string): Order {
    return new Order(text, Channel.Store);
  }

  parse(): string {
    return `${this.reference}@${this.channel}`;
  }

  bill(): Cents {
    return applyTax(this.total);
  }
}
