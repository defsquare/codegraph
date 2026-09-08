import type { Order } from "./order.js";

/** A variable holding an arrow: two entities, the arrow a child of the variable. */
export const onShipped = (order: Order): void => log(`shipped ${order.reference}`);

/** Two arrows STARTING ON THE SAME LINE — the column keeps their ids apart. */
export function both(order: Order): () => void {
  return chain(() => log(`packing ${order.reference}`), () => log(`shipping ${order.reference}`));
}

export function chain(first: () => void, second: () => void): () => void {
  return () => {
    first();
    second();
  };
}

/** A nameless function expression, and a top-level arrow with no named owner. */
export const shout = function (message: string): string {
  return message.toUpperCase();
};

(() => {
  log("module loaded");
})();

function log(message: string): void {
  console.log(message);
}
