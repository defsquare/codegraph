import { load, Thing } from "legacy-lib";

/** A module augmentation: members declared here merge into the corpus-declared `Thing`. */
declare module "legacy-lib" {
  interface Thing {
    extra(): void;
  }
}

declare global {
  /** Lives in the global scope, is written in this file: a child of this file. */
  interface AcmeWindow {
    acme: string;
  }
}

export class Wrapper extends Thing {
  static open(id: number): Wrapper {
    const thing = load(id);
    thing.extra();
    return thing as Wrapper;
  }
}
