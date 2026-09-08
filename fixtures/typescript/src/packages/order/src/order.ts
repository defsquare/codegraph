import { applyTax } from "@acme/pricing";
import { Channel } from "@order/channel";
import { AbstractOrder } from "./abstract-order.js";
import type { Cents } from "./money.js";

/** A customer order. */
export class Order extends AbstractOrder {
  /** TypeScript folds nothing at the declaration: the initializer rides `unevaluated`, as written. */
  static readonly MAX_LINES = 4 * 25;

  /** A literal initializer on a readonly field IS a written value. */
  static readonly CURRENCY = "EUR";

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
