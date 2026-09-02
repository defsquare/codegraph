import type { TypeDossier } from "@codegraph/analyzer";
import type { OperationBlock } from "./schema.js";
import type { OperationUnit, TemplateKind } from "./units.js";

/**
 * TEMPLATED BLOCKS for trivial members (units.ts decides which). No model call:
 * the block is a deterministic function of the facts, confidence 1, and the
 * `owner` is `unknown` because operations are explained before their type —
 * the type's record, not this one, says what the type is.
 */
export function templateBlock(unit: OperationUnit, kind: TemplateKind, type: TypeDossier): OperationBlock {
  const typeName = type.name ?? type.id;
  const name = unit.fact.name ?? (unit.fact.kind === "constructor" ? typeName : unit.fact.id);
  const fields = [...new Set(unit.fact.accesses.map((a) => a.field).filter((f): f is string => f !== undefined))];
  const fieldList = fields.length === 0 ? "" : ` (${fields.map((f) => `\`${f}\``).join(", ")})`;

  const description = ((): string => {
    switch (kind) {
      case "getter":
        return fields.length === 1 ? `Getter: returns the \`${fields[0]}\` field of \`${typeName}\`.` : `Getter on \`${typeName}\`${fieldList}.`;
      case "setter":
        return fields.length === 1 ? `Setter: assigns the \`${fields[0]}\` field of \`${typeName}\`.` : `Setter on \`${typeName}\`${fieldList}.`;
      case "objectContract":
        return `Object contract: \`${name}\` of \`${typeName}\`, with no domain rule.`;
      case "trivialConstructor":
        return `Constructor: assigns the fields of \`${typeName}\`${fieldList}.`;
    }
  })();

  return {
    name,
    description,
    safe: kind === "getter" || kind === "objectContract",
    idempotent: kind === "getter" || kind === "objectContract" || kind === "setter",
    owner: "unknown",
    handlesCommand: null,
    emits: [],
    preconditions: [],
    postconditions: [],
    invariantsEnforced: [],
    usesSpi: [],
    domainTerms: fields,
    confidence: 1,
  };
}
