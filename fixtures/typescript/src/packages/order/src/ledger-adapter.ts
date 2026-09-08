import { LedgerClient } from "@megacorp/ledger";
import type { Order } from "./order.js";

/**
 * Extends a type from a package that is NOT installed: the base is a stub in
 * `<unresolved>`, and every call through the `any` it leaves behind is
 * dropped and counted — never guessed.
 */
export class LedgerAdapter extends LedgerClient {
  post(order: Order): void {
    this.send(order.reference);
  }
}
