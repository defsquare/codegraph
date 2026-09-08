/** Tax rules. A workspace package: imported by NAME, with nothing installed and nothing built. */
export const TAX_RATE = 0.2;

export interface Priced {
  price(): number;
}

export function applyTax(amount: number): number {
  return Math.round(amount * (1 + TAX_RATE));
}
