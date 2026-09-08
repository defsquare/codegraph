/** A plain enum occupies both spaces; its members are properties with values. */
export enum Channel {
  Web = 0,
  Store = 10,
  Phone = Store + 1,
}

/** A const enum is inlined at emit: type space only. */
export const enum Priority {
  Low,
  High,
}
