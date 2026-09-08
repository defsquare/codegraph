/** A basket being filled. */
export class Basket {
  private total = 0;
  private readonly lines: Line[] = [];

  add(line: Line): void {
    this.lines.push(line);
    this.total += line.amount;
  }

  get count(): number {
    return this.lines.filter((line) => line.amount > 0).length;
  }
}

export class Line {
  constructor(readonly amount: number) {}
}

/** An object literal used as a namespace: a variable with property and method children. */
export const Ops = {
  "max.lines": 100,
  create(): Basket {
    return new Basket();
  },
  [Symbol.iterator]: function* () {
    yield new Line(1);
  },
};
