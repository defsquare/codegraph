import { Order } from "./order.js";

/** A corpus exception, extending a lib type. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A guard `if`, a `catch` whose narrowed rethrow resolves, and a wrap: three
 * throw sites, one target. A rethrow of the raw `unknown` binding would be
 * dropped and counted — the checker names no type for it.
 */
export function ensure(orders: Order[]): number {
  if (orders.length === 0) throw new OrderError("empty");
  try {
    return orders.map((order) => order.bill()).reduce((a, b) => a + b, 0);
  } catch (error) {
    if (error instanceof OrderError) throw error;
    throw new OrderError(String(error));
  }
}

/** Overloads: ONE entity, anchored at the implementation. */
export function describe(order: Order): string;
export function describe(orders: Order[]): string[];
export function describe(input: Order | Order[]): string | string[] {
  if (Array.isArray(input)) return input.map((order) => order.parse());
  return input.parse();
}

export function reject(): never {
  throw "not an error type";
}
