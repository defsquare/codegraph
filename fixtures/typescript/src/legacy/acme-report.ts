/// <reference path="./acme.ts" />

/** The same namespace merged ACROSS files: a second entity, in this file; `Registry` resolves into acme.ts. */
namespace Acme.Order {
  export class Report extends Registry {
    render(): string {
      return this.items.join(", ");
    }
  }

  export type Line = string;
}
