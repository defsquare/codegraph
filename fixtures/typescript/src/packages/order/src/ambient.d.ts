/** An ambient module the corpus DECLARES (this file is a script, so the block declares rather than augments): a module entity, not a stub. */
declare module "legacy-lib" {
  export class Thing {
    id: number;
    describe(): string;
  }
  export function load(id: number): Thing;
}
