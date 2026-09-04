import { z } from "zod";
import {
  DOMAIN_CONCEPTS,
  ENFORCEMENTS,
  EVENT_KINDS,
  FIELD_KINDS,
  INTERFACE_ROLES,
  OPERATION_OWNERS,
  SYNC_PATTERNS,
} from "./ddd.js";

/**
 * THE SIDE-CAR CONTRACT. One Zod definition per block yields the TypeScript
 * type, the runtime validator for what the model returns, and the JSON Schema
 * sent to the provider as the strict response format — the same rule core
 * applies to the interchange (CLAUDE.md, Stack).
 *
 * Every block follows the Specy metamodel's convention: a `name` (the
 * ubiquitous-language name the model proposes), a `description` (the prose
 * explanation) and — on the record, not the block — a `metadata` map. The
 * `satisfies` list is omitted: no requirements are input here.
 *
 * STRICT-COMPATIBLE BY CONSTRUCTION. Providers' strict structured output
 * requires every property to be required and no additional properties, so
 * "optional" is expressed as `.nullable()`, never `.optional()`; and no
 * numeric or string constraints are emitted — `confidence` is clamped on
 * receipt rather than constrained in the schema.
 */

export const INSIGHTS_KIND = "codegraph.insights/1";
export const INSIGHTS_GENERATOR = "@codegraph/insights";
/** The vocabulary a side-car speaks (see ddd.ts). */
export const INSIGHTS_METAMODEL = "specy.domain/3";
/** Bump whenever the prompt or a block shape changes: every fingerprint includes it. */
export const PROMPT_VERSION = "1";

export const LEVELS = ["operation", "type", "module"] as const;
export type Level = (typeof LEVELS)[number];

const name = z.string();
const description = z.string();
const confidence = z.number();

/** Specy § Operation. */
export const OperationBlock = z.object({
  name,
  description,
  /** Read-only (no state mutation) or not. */
  safe: z.boolean(),
  idempotent: z.boolean().nullable(),
  owner: z.enum(OPERATION_OWNERS),
  /** The command this operation handles, when it is a command handler. */
  handlesCommand: z.string().nullable(),
  emits: z.array(z.object({ name, kind: z.enum(EVENT_KINDS) })),
  preconditions: z.array(z.object({ name, predicate: z.string(), violationReason: z.string() })),
  postconditions: z.array(z.object({ name, predicate: z.string() })),
  invariantsEnforced: z.array(z.string()),
  /** External capabilities the operation needs (persistence, messaging, a gateway…), as SPIs. */
  usesSpi: z.array(z.object({ name, capability: z.string() })),
  domainTerms: z.array(z.string()),
  confidence,
});
export type OperationBlock = z.infer<typeof OperationBlock>;

/** Specy § Entity / Aggregate / Value Type / … — which concept a type realizes, and its structure. */
export const TypeBlock = z.object({
  name,
  description,
  concept: z.enum(DOMAIN_CONCEPTS),
  eventKind: z.enum(EVENT_KINDS).nullable(),
  interfaceRole: z.enum(INTERFACE_ROLES).nullable(),
  /** For an aggregate: this type is the root. For an entity: it is inside `containedIn`. */
  aggregateRoot: z.boolean().nullable(),
  containedIn: z.string().nullable(),
  syncPattern: z.enum(SYNC_PATTERNS).nullable(),
  /** The identity field, for entities. */
  identity: z.string().nullable(),
  fields: z.array(z.object({ name, type: z.string(), kind: z.enum(FIELD_KINDS) })),
  invariants: z.array(z.object({ name, predicate: z.string(), enforcement: z.enum(ENFORCEMENTS) })),
  stateMachine: z
    .object({
      states: z.array(z.string()),
      transitions: z.array(z.object({ from: z.string(), to: z.string(), operation: z.string() })),
    })
    .nullable(),
  relatesTo: z.array(z.object({ name, concept: z.enum(DOMAIN_CONCEPTS) })),
  /** Operations that form this type's public surface (its API). */
  exposes: z.array(z.string()),
  /** Ports this type needs from others, with the role they play for it. */
  dependsOn: z.array(z.object({ name, role: z.enum(INTERFACE_ROLES) })),
  domainTerms: z.array(z.string()),
  confidence,
});
export type TypeBlock = z.infer<typeof TypeBlock>;

/** Specy § Module. */
export const ModuleBlock = z.object({
  name,
  description,
  apis: z.array(z.object({ name, operations: z.array(z.string()) })),
  spis: z.array(z.object({ name, capability: z.string() })),
  dependsOn: z.array(z.string()),
  concepts: z.array(z.object({ name, concept: z.enum(DOMAIN_CONCEPTS) })),
  boundedContextHint: z.object({ name, rationale: z.string() }).nullable(),
  /** For a module in a dependency cycle: why the group is inseparable, or how to split it. */
  sharedKernelHint: z.string().nullable(),
  ubiquitousLanguage: z.array(z.object({ term: z.string(), definition: z.string() })),
  confidence,
});
export type ModuleBlock = z.infer<typeof ModuleBlock>;

export const BLOCKS = { operation: OperationBlock, type: TypeBlock, module: ModuleBlock } as const;
export type Block = OperationBlock | TypeBlock | ModuleBlock;
export type BlockOf<L extends Level> = z.infer<(typeof BLOCKS)[L]>;

/** What the model returns for a unit whose members form a cycle: one block per member id. */
export function sccResponseSchema<L extends Level>(level: L) {
  return z.object({ members: z.array(z.object({ id: z.string(), block: BLOCKS[level] })) });
}

/** The natural key (core's `NaturalKey`), carried so a re-extraction re-joins without parsing ids. */
export const RecordKey = z.object({
  lang: z.string(),
  module: z.string(),
  symbol: z.string(),
  disambiguator: z.string().optional(),
});
export type RecordKey = z.infer<typeof RecordKey>;

export const RecordUsage = z.object({
  promptTokens: z.int().nonnegative(),
  completionTokens: z.int().nonnegative(),
  cost: z.number().optional(),
});
export type RecordUsage = z.infer<typeof RecordUsage>;

export const ORIGINS = ["llm", "template"] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * One record shape per level. The KEY ORDER here is the order on the wire:
 * `encodeInsights` re-parses every record through this schema before
 * stringifying, so a record built in memory and one read back from disk
 * serialize to the same bytes.
 */
function recordShape<L extends Level, B extends z.ZodType>(level: L, block: B) {
  return z.object({
    t: z.literal("i"),
    /** The rendered entity id — compared as an opaque token, never parsed. */
    id: z.string().min(1),
    key: RecordKey.optional(),
    level: z.literal(level),
    kind: z.string(),
    name: z.string().optional(),
    /** The anchor file, root-relative. */
    file: z.string().optional(),
    /** Present when the unit sits in a dependency cycle: every member, sorted, this id included. */
    scc: z.array(z.string()).optional(),
    origin: z.enum(ORIGINS),
    block,
    /** sha256 hex of everything the explanation was computed from — see fingerprint.ts. */
    fingerprint: z.string().length(64),
    model: z.string().optional(),
    usage: RecordUsage.optional(),
    /** The metamodel convention's free key/value map. */
    metadata: z.record(z.string(), z.string()).optional(),
  });
}

export const InsightRecord = z.discriminatedUnion("level", [
  recordShape("operation", OperationBlock),
  recordShape("type", TypeBlock),
  recordShape("module", ModuleBlock),
]);
export type InsightRecord = z.infer<typeof InsightRecord>;

export const ViewDescriptorSchema = z.object({ name: z.string(), filters: z.array(z.string()) });

export const InsightsHeader = z.object({
  t: z.literal("header"),
  kind: z.literal(INSIGHTS_KIND),
  generatedBy: z.string(),
  promptVersion: z.string(),
  metamodel: z.string(),
  models: z.object({ leaf: z.string(), rollup: z.string() }),
  /** Which client served the calls (`openrouter`, `cloudflare`, …); absent on files written before it was recorded. */
  provider: z.string().optional(),
  depth: z.int().nonnegative(),
  source: z.object({
    paths: z.array(z.string()),
    langs: z.array(z.string()),
    view: ViewDescriptorSchema,
  }),
});
export type InsightsHeader = z.infer<typeof InsightsHeader>;

export const InsightsEof = z.object({
  t: z.literal("eof"),
  counts: z.object({
    records: z.int().nonnegative(),
    llm: z.int().nonnegative(),
    template: z.int().nonnegative(),
    reused: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  usage: RecordUsage,
  /** ISO-8601; the ONLY timestamp in the file, so the body stays diffable. */
  generatedAt: z.string(),
});
export type InsightsEof = z.infer<typeof InsightsEof>;

export type JsonSchema = { [key: string]: unknown };

/**
 * Harden a generated schema for strict structured output: every object gets
 * `additionalProperties: false` and `required` = all of its properties,
 * constraint keywords the strict dialects reject are dropped, and the
 * document identifiers are removed. Deterministic: same input, same output.
 */
export function strictify(schema: JsonSchema): JsonSchema {
  const DROP = new Set(["$schema", "$id", "minimum", "maximum", "minLength", "maxLength", "pattern", "format"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (DROP.has(key)) continue;
      out[key] = key === "properties" && value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
        : walk(value);
    }
    if (out["type"] === "object" && out["properties"] !== undefined) {
      out["additionalProperties"] = false;
      out["required"] = Object.keys(out["properties"] as Record<string, unknown>);
    }
    return out;
  };
  return walk(schema) as JsonSchema;
}

/** The JSON Schema for a level's block, or for the cycle response of that level. */
export function responseJsonSchema(level: Level, shape: "block" | "scc" = "block"): JsonSchema {
  const zod = shape === "block" ? BLOCKS[level] : sccResponseSchema(level);
  return strictify(z.toJSONSchema(zod, { target: "draft-2020-12", io: "output" }) as JsonSchema);
}

/** The response schema's name, as the provider requires it (a-z, 0-9, `_`, `-`). */
export function responseSchemaName(level: Level, shape: "block" | "scc" = "block"): string {
  return shape === "block" ? `codegraph_${level}` : `codegraph_${level}_cycle`;
}

/** Bring a model's block into range without rejecting it: confidence is a hint, not a fact. */
export function clampConfidence<B extends { confidence: number }>(block: B): B {
  const c = Number.isFinite(block.confidence) ? Math.min(1, Math.max(0, block.confidence)) : 0;
  return c === block.confidence ? block : { ...block, confidence: c };
}
