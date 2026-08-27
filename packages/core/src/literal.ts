import { z } from "zod";
import { EntityId } from "./primitives.js";

/**
 * THE VALUE DOOR (METAMODEL.md §1.6): a written, declaration-site value — what
 * an annotation argument, a constant initializer or a default carries in the
 * SOURCE. Never runtime state.
 *
 * Two rules decide everything here:
 *
 * 1. **A Literal is what is written.** It is emitted only when the language
 *    fixes the value at the declaration — a literal, or an expression that
 *    folds from constants (Java: a JLS compile-time constant expression).
 *    Anything else is `unevaluated` (the source text, kept and labeled) or
 *    absent. Nothing downstream may "run" one.
 * 2. **Ids inside values count for closure** (§8a). `enum.type`, `type.type`
 *    and a nested annotation's type resolve to a declared entity or a stub
 *    exactly like an edge endpoint — and in the JSONL encoding they are
 *    file-scoped surrogates, so a dangling one is unwritable.
 *
 * The tag set is a closed, core-owned vocabulary (MM-3): an extractor that
 * meets a value it cannot express uses `unevaluated`, it does not invent a tag.
 */

/**
 * A number's canonical decimal TEXT, plus the three IEEE specials a Java
 * `double` constant can legally fold to (`1.0/0.0` is a compile-time constant).
 * Text rather than a JSON number because JSON has one numeric type and it is a
 * double: `9223372036854775807` parses back as `9223372036854776000`, so a
 * `long` would silently change value on the wire.
 */
const DECIMAL = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|-?Infinity)$/;

/** One argument of an annotation use, always named (§1.6). */
export interface NamedArgument {
  readonly name: string;
  readonly value: Literal;
}

export type Literal =
  /** Chars ride as one-character strings; the declared type keeps `'a'` and `"a"` apart. */
  | { readonly k: "string"; readonly v: string }
  | { readonly k: "number"; readonly v: string }
  | { readonly k: "boolean"; readonly v: boolean }
  | { readonly k: "null" }
  /** A reference to the TYPE plus the constant's simple name — never a fabricated member. */
  | { readonly k: "enum"; readonly type: EntityId; readonly name: string }
  /** `Foo.class` and kin. The written type use still emits its own `reference` edge. */
  | { readonly k: "type"; readonly type: EntityId }
  /** Written order kept — a source fact, like parameter order. */
  | { readonly k: "array"; readonly items: readonly Literal[] }
  | { readonly k: "annotation"; readonly type: EntityId; readonly arguments: readonly NamedArgument[] }
  /** A written constant expression the extractor did not fold; the text is still a fact. */
  | { readonly k: "unevaluated"; readonly source: string };

export const Literal: z.ZodType<Literal> = z
  .discriminatedUnion("k", [
    z.object({ k: z.literal("string"), v: z.string() }),
    z.object({ k: z.literal("number"), v: z.string().regex(DECIMAL, "must be canonical decimal text") }),
    z.object({ k: z.literal("boolean"), v: z.boolean() }),
    z.object({ k: z.literal("null") }),
    z.object({ k: z.literal("enum"), type: EntityId, name: z.string().min(1) }),
    z.object({ k: z.literal("type"), type: EntityId }),
    z.object({
      k: z.literal("array"),
      get items() {
        return z.array(Literal);
      },
    }),
    z.object({
      k: z.literal("annotation"),
      type: EntityId,
      get arguments() {
        return z.array(NamedArgument);
      },
    }),
    z.object({ k: z.literal("unevaluated"), source: z.string().min(1) }),
  ])
  .meta({
    id: "Literal",
    description:
      "A written, declaration-site value (METAMODEL.md §1.6). Never runtime state: " +
      "an expression the extractor did not fold rides as `unevaluated` with its source text.",
  }) as unknown as z.ZodType<Literal>;

export const NamedArgument: z.ZodType<NamedArgument> = z
  .object({
    name: z.string().min(1),
    get value() {
      return Literal;
    },
  })
  .meta({
    id: "NamedArgument",
    description: "One argument of an annotation use; a language-implicit name is normalized explicit.",
  }) as unknown as z.ZodType<NamedArgument>;

/** One id a value points at, and where inside the value it was written. */
export interface LiteralReference {
  readonly path: string;
  readonly id: EntityId;
}

/**
 * Every id inside a value, in written order — what closure walks (§8a). The
 * paths are relative to the value itself, so a caller prefixes its own
 * (`entities[3].value`, `edges[7].arguments[0].value`).
 */
export function literalReferences(value: Literal, prefix = ""): LiteralReference[] {
  switch (value.k) {
    case "enum":
    case "type":
      return [{ path: `${prefix}.type`, id: value.type }];
    case "array":
      return value.items.flatMap((item, index) => literalReferences(item, `${prefix}.items[${index}]`));
    case "annotation":
      return [
        { path: `${prefix}.type`, id: value.type },
        ...argumentReferences(value.arguments, `${prefix}.arguments`),
      ];
    default:
      return [];
  }
}

/** The same walk over an annotation use's arguments (§4's `annotationUse`). */
export function argumentReferences(
  args: readonly NamedArgument[],
  prefix: string,
): LiteralReference[] {
  return args.flatMap((argument, index) =>
    literalReferences(argument.value, `${prefix}[${index}].value`),
  );
}
