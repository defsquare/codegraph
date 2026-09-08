import type { Order } from "./order.js";
import { PROMO } from "./promo#2024.js";

/** A nameless default export: named `default`. */
export default function (order: Order): string {
  return `${order.reference}:${PROMO}`;
}
