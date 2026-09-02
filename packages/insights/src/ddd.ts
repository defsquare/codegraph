/**
 * THE SPECY DOMAIN VOCABULARY, restated as literals.
 *
 * Source of truth: the Specy domain metamodel
 * (`specy/skill/src/metamodels/DOMAIN-METAMODEL.md`, "Specy v3"). Every
 * value below is the camel-cased name of a section of that document, so the
 * skill that later turns a side-car into a `.domain` file maps records without
 * a translation table. The metamodel lives in another repository, so this file
 * cites it rather than importing it; `INSIGHTS_METAMODEL` in schema.ts names
 * the version a side-car speaks.
 *
 * Two values are ours, not Specy's, because an extracted corpus contains code
 * that has no place in a domain model: `notDomain` (DTO plumbing, configuration,
 * test helpers, framework glue) and `unknown` (the model could not decide).
 */
export const DOMAIN_CONCEPTS = [
  "boundedContext",
  "module",
  "interface",
  "operation",
  "command",
  "query",
  "reaction",
  "entity",
  "readOnlyEntity",
  "aggregate",
  "stateMachine",
  "repository",
  "event",
  "valueType",
  "enum",
  "domainService",
  "applicationService",
  "infrastructureService",
  "invariant",
  "precondition",
  "postcondition",
  "agreement",
  "reconciliation",
  "notDomain",
  "unknown",
] as const;
export type DomainConcept = (typeof DOMAIN_CONCEPTS)[number];

/** DOMAIN-METAMODEL.md § Event: the four subtypes. */
export const EVENT_KINDS = ["internal", "external", "error", "temporal"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** § Interface: driving (API) or driven (SPI) port. */
export const INTERFACE_ROLES = ["API", "SPI"] as const;
export type InterfaceRole = (typeof INTERFACE_ROLES)[number];

/** § Operation: "owned by exactly one" of these. */
export const OPERATION_OWNERS = [
  "entity",
  "aggregate",
  "domainService",
  "applicationService",
  "infrastructureService",
  "repository",
  "valueType",
  "unknown",
] as const;
export type OperationOwner = (typeof OPERATION_OWNERS)[number];

/** § Invariant: the declared enforcement strategy. */
export const ENFORCEMENTS = ["rejection", "compensation", "alert"] as const;
export type Enforcement = (typeof ENFORCEMENTS)[number];

/** § Read-only Entity: how a master-data copy stays in sync with its owner. */
export const SYNC_PATTERNS = ["synchronous-query", "asynchronous-projection"] as const;
export type SyncPattern = (typeof SYNC_PATTERNS)[number];

/** § Entity, "Structure": what a field's type is, in the metamodel's terms. */
export const FIELD_KINDS = ["primitive", "valueType", "entityReference", "enum", "collection", "unknown"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * One-line definitions the prompt hands the model, lifted from the metamodel's
 * section openings. Kept here, next to the vocabulary, so the words the model
 * is asked to use and the meaning it is given for them cannot drift apart.
 */
export const CONCEPT_DEFINITIONS: Readonly<Record<DomainConcept, string>> = {
  boundedContext:
    "a boundary within which the model and its language are consistent; interactions across it are asynchronous and no transaction spans it",
  module: "a unit of decomposition grouping related domain concepts behind APIs it exposes and SPIs it depends on",
  interface: "a named contract of operation signatures — an API (driving port, selects owned operations) or an SPI (driven port, defines what the domain needs)",
  operation: "a named unit of behavior with typed inputs and one typed output, safe (read-only) or unsafe (mutating), owned by exactly one artefact",
  command: "an inbound message expressing an intention to change state; handled by exactly one operation; succeeds with events or fails with an error event",
  query: "an inbound message requesting current state; safe and idempotent; reads through a repository",
  reaction: "the only way an event causes a command: a named rule with a trigger event, an optional guard over state, and the command it issues",
  entity: "a domain concept with a fixed identity and a lifecycle; equal by identity; owns operations that move it to its next state",
  readOnlyEntity: "master data whose state is owned by another context or system; observable here, never mutated locally",
  aggregate: "an entity that is the root of a cluster of entities and enforces the cluster's invariants; all changes pass through the root",
  stateMachine: "the explicit states and transitions of an entity's lifecycle; entity operations trigger transitions",
  repository: "the collection-like persistence port derived from an entity or aggregate root (store, getById, remove, search, findByX); never hand-authored, never mutates domain state",
  event: "a recorded, append-only fact: internal (raised by an operation), external (from an upstream context), error (an operation failure) or temporal (time reached)",
  valueType: "an immutable concept defined entirely by its attributes; equal by value; validated at construction; operations return new values",
  enum: "a closed, named set of values used to constrain a field; no identity, no lifecycle",
  domainService: "operations spanning several entities or aggregates where no single owner would be natural; may change several of them",
  applicationService: "an orchestrator interpreting requests from the presentation layer and delegating to the domain; use-case state only, no domain logic; technology-bound",
  infrastructureService: "an adapter exposing an external system's capabilities in the domain's language, behind an SPI; the Anti-Corruption Layer is one",
  invariant: "a named predicate over state that must hold at every observable point of a consistency boundary, with a declared enforcement (rejection, compensation, alert)",
  precondition: "a predicate over state-before and arguments that must hold before a behavior runs; violation is rejection with a stated reason",
  postcondition: "a predicate over state-before, state-after and arguments the behavior guarantees; a failure is a defect, never a domain outcome",
  agreement: "a truth spanning several aggregates that no single transaction can verify, maintained by a reconciliation",
  reconciliation: "the mechanism detecting an agreement's violation and issuing compensating commands, with an escalation chain that terminates",
  notDomain: "technical code with no domain meaning: DTO plumbing, configuration, serialization, framework glue, test helpers",
  unknown: "the code shown does not let you decide",
};
