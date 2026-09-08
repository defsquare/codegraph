import type { Priceable } from "./priceable.js";

/** A type alias: type space only; its constituent is a reference. */
export type Cents = number;

/** A value type implementing a corpus interface, with accessors, a static and a #private. */
export class Money implements Priceable {
  #secret = "vault";

  constructor(private readonly cents: Cents) {}

  static zero(): Money {
    return new Money(0);
  }

  get amount(): number {
    return this.cents / 100;
  }

  set amount(value: number) {
    this.#secret = String(value);
  }

  price(): number {
    return this.cents;
  }

  /** A string-literal member name: escaped in the key, `.` included. */
  "as.text"(): string {
    return `${this.amount} (${this.#secret})`;
  }
}
