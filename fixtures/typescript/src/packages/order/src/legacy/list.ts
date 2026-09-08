/** Recursion: `length` calls `tail.length` — a self-edge, dropped at the source. */
export class List {
  head = "";
  tail?: List;

  length(): number {
    return 1 + (this.tail ? this.tail.length() : 0);
  }
}
