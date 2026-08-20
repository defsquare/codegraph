import {
  PROVENANCES,
  getProfile,
  isStubEntity,
  selfReferences,
  unknownReferences,
  validateModel,
  type Entity,
  type EntityId,
  type SourceAnchor,
  type ValidationCode,
} from "@codegraph/core";
import type { ModelUnion } from "./load.js";
import { compareIds, sortedUnique } from "./order.js";

/**
 * THE ACCEPTANCE GATE (PLAN.md §8, CLAUDE.md "Tests first, properties as
 * contract"): the metamodel invariants, checked over a loaded union and
 * reported as data.
 *
 * It lives in the analyzer, not in the CLI, because it is pure computation over
 * a `ModelUnion` — the CLI is a shell that formats what this returns (M4
 * decision 7), and the property suite, a future `viz` health panel and a CI job
 * must all be able to ask the same question and get the same answer.
 *
 * It COMPOSES what already exists rather than restating it: closure and
 * self-reference come from core's `unknownReferences`/`selfReferences`, profile
 * validity from core's `validateModel` (which runs `validateEntity` on every
 * entity). What is added here is what nothing checked before — the candidates
 * rule, edge anchor well-formedness, and union-wide conflicting redeclaration.
 *
 * IT NEVER THROWS ON A FINDING. A report is the product: an extractor author
 * pointing this at a broken output wants every rule's verdict in one run, not
 * the first exception.
 */

/**
 * How much a finding costs. `error` means the model breaks a stated invariant
 * and the gate fails; `warning` means something could not be checked, or is
 * suspicious but permitted by the metamodel as written. Only errors flip
 * {@link ConformanceReport.ok}, so a warning can be added later without
 * silently turning green corpora red.
 */
export type ConformanceSeverity = "error" | "warning";

/**
 * The invariant families, in reporting order. Each finding names exactly one:
 * an extractor author fixes a RULE, not a list of unrelated messages.
 */
export const CONFORMANCE_RULES = [
  "closure",
  "self-reference",
  "provenance",
  "candidates",
  "profile",
  "anchor",
  "duplicate-id",
] as const;
export type ConformanceRule = (typeof CONFORMANCE_RULES)[number];

/** Codes this module owns. Profile findings carry core's `VALIDATION_CODES` instead. */
export const CONFORMANCE_CODES = [
  "dangling-reference",
  "self-edge",
  "invalid-provenance",
  "candidates-empty",
  "candidates-without-uncertainty",
  "candidates-missing",
  "missing-anchor",
  "anchor-file-empty",
  "anchor-span-not-1-based",
  "anchor-span-reversed",
  "duplicate-id-conflict",
  "unknown-profile",
] as const;
export type ConformanceCode = (typeof CONFORMANCE_CODES)[number] | ValidationCode;

/**
 * One violation: which rule, which code, where it is written, which id is at
 * fault, and a sentence that names all of it. Consumers match on `code`, never
 * on `message` — the message is for humans and may be reworded.
 */
export interface ConformanceFinding {
  readonly severity: ConformanceSeverity;
  readonly rule: ConformanceRule;
  readonly code: ConformanceCode;
  /** Index of the offending model among the loader's inputs. */
  readonly modelIndex: number;
  /** The model's source label — a file path, typically. */
  readonly label: string;
  /** Where inside that model, e.g. `edges[12].to`, `entities[3]`, `lang`. */
  readonly path: string;
  /** The entity id at fault, when the finding is about one. */
  readonly id: EntityId | undefined;
  /** One sentence, naming the id and the rule it broke. */
  readonly message: string;
}

export interface ConformanceCounts {
  readonly errors: number;
  readonly warnings: number;
  /** True totals, counted BEFORE `maxPerRule` truncation. */
  readonly byCode: Readonly<Record<string, number>>;
  readonly byRule: Readonly<Record<ConformanceRule, number>>;
  /** Findings `maxPerRule` dropped from `findings`; the counts above still include them. */
  readonly suppressed: number;
}

/** What was checked, so a clean verdict states what it is a verdict about. */
export interface ConformanceSubject {
  readonly models: number;
  readonly entities: number;
  /** Degraded external entities (METAMODEL.md §6). They count as declared for closure. */
  readonly stubs: number;
  readonly edges: number;
  readonly langs: readonly string[];
  /** Source labels in input order. */
  readonly sources: readonly string[];
  /** Langs with no profile in core's registry: profile validity could not run for them. */
  readonly unknownProfiles: readonly string[];
}

export interface ConformanceReport {
  /** No error-severity finding. Warnings do not fail the gate. */
  readonly ok: boolean;
  /** Sorted deterministically; truncated per rule when `maxPerRule` is set. */
  readonly findings: readonly ConformanceFinding[];
  readonly counts: ConformanceCounts;
  readonly subject: ConformanceSubject;
}

export interface ConformanceOptions {
  /**
   * Keep at most this many findings per rule in `findings`. One systemic
   * extractor bug otherwise buries every other rule under 20 000 identical
   * lines. Counts stay exact; `counts.suppressed` says how many were dropped.
   * Omit or 0 for no limit.
   */
  readonly maxPerRule?: number | undefined;
  /**
   * Ids declared outside this union that still count as known for closure —
   * for checking one model of a corpus whose siblings are not loaded.
   */
  readonly known?: Iterable<EntityId> | undefined;
}

/**
 * One id may be declared several times (TypeScript declaration merging, C#
 * partial classes — METAMODEL.md §1.1); only a disagreement on kind or trait
 * set is a conflict. `load.ts` applies the same rule privately while building
 * its diagnostics; this is the exported form, and the two must stay in step.
 */
export function sameEntityDeclaration(a: Entity, b: Entity): boolean {
  if (a.kind !== b.kind) return false;
  const left = sortedUnique(a.traits);
  const right = sortedUnique(b.traits);
  return left.length === right.length && left.every((trait, i) => trait === right[i]);
}

const PROVENANCE_SET: ReadonlySet<string> = new Set<string>(PROVENANCES);

/**
 * Codes core's `validateModel` also emits that a dedicated rule owns here.
 * Reporting a defect twice under two rules would make the counts lie, and both
 * of these must be checked even when the model's lang has NO profile, which is
 * exactly what the dedicated rules do.
 */
const OWNED_BY_ANOTHER_RULE: ReadonlySet<string> = new Set<string>([
  "missing-provenance",
  "duplicate-entity-id",
]);

function traitList(entity: Entity): string {
  return `[${sortedUnique(entity.traits).join(", ")}]`;
}

function isAnchor(value: unknown): value is SourceAnchor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { file?: unknown; span?: unknown };
  return typeof candidate.file === "string" && Array.isArray(candidate.span) && candidate.span.length === 2;
}

/** A collector, so every rule reports through one shape and one severity policy. */
class Findings {
  private readonly items: ConformanceFinding[] = [];

  add(finding: ConformanceFinding): void {
    this.items.push(finding);
  }

  /**
   * Deterministic order: severity, then rule in `CONFORMANCE_RULES` order, then
   * the model. Within a group the sort is STABLE (ES2019 guarantees it), so the
   * findings keep the order they were produced in — ascending entity/edge index,
   * which is the order an extractor author reads their own output in. Sorting
   * the `path` strings instead would put `edges[10]` before `edges[9]`.
   */
  sorted(): ConformanceFinding[] {
    const ruleRank = new Map<ConformanceRule, number>(CONFORMANCE_RULES.map((rule, i) => [rule, i]));
    return [...this.items].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        (ruleRank.get(a.rule) ?? 0) - (ruleRank.get(b.rule) ?? 0) ||
        a.modelIndex - b.modelIndex ||
        compareIds(a.label, b.label),
    );
  }
}

function severityRank(severity: ConformanceSeverity): number {
  return severity === "error" ? 0 : 1;
}

/**
 * Check every PLAN.md §8 invariant over a loaded union and return the verdict.
 * Never throws on a finding.
 */
export function checkConformance(union: ModelUnion, options: ConformanceOptions = {}): ConformanceReport {
  const findings = new Findings();

  // Closure holds over the CORPUS, not over one file: a model may legitimately
  // reference an id a sibling model declares. Stubs are declared entities, so
  // they are known (METAMODEL.md §6, CLAUDE.md invariant 10).
  const known = new Set<EntityId>(options.known ?? []);
  for (const entity of union.entities) known.add(entity.id);

  const unknownProfiles = new Set<string>();
  const declarations = new Map<EntityId, DeclarationSite[]>();

  union.models.forEach((model, i) => {
    const source = union.sources[i];
    const modelIndex = source?.index ?? i;
    const label = source?.label ?? `model[${i}]`;
    const at = (
      severity: ConformanceSeverity,
      rule: ConformanceRule,
      code: ConformanceCode,
      path: string,
      id: EntityId | undefined,
      message: string,
    ): void => findings.add({ severity, rule, code, modelIndex, label, path, id, message });

    // ---- CLOSURE ------------------------------------------------------------
    for (const ref of unknownReferences(model, known)) {
      at(
        "error",
        "closure",
        "dangling-reference",
        ref.path,
        ref.id,
        `${ref.path} points at "${ref.id}", which no entity in the corpus declares (stubs count as declared)`,
      );
    }

    // ---- NO SELF-REFERENCE --------------------------------------------------
    for (const self of selfReferences(model)) {
      at(
        "error",
        "self-reference",
        "self-edge",
        self.path,
        self.edge.from,
        `${self.path}: ${self.edge.edge} edge from "${self.edge.from}" to itself — every edge must satisfy from !== to`,
      );
    }

    // ---- PROVENANCE, CANDIDATES, ANCHORS ------------------------------------
    model.edges.forEach((edge, index) => {
      const path = `edges[${index}]`;

      // The Zod schema already guarantees provenance on a parsed model; the check
      // is repeated because a union can be built in memory and because "provenance
      // always set" is the invariant, not "the parser happened to run".
      const provenance: unknown = edge.provenance;
      if (typeof provenance !== "string" || !PROVENANCE_SET.has(provenance)) {
        at(
          "error",
          "provenance",
          "invalid-provenance",
          `${path}.provenance`,
          edge.from,
          `${path} (${edge.from} -> ${edge.to}) has provenance ${JSON.stringify(provenance)}; it must be one of ${PROVENANCES.join(", ")}`,
        );
      }

      // THE CANDIDATES RULE — "non-empty iff resolution was ambiguous"
      // (METAMODEL.md §4, PLAN.md §8), which nothing checked before M4. Read as
      // two directions, and only the first is an error:
      //   present-but-empty  -> ERROR. It asserts "resolution was ambiguous, and
      //     here are zero possibilities", which states nothing. Certain
      //     resolution is expressed by OMITTING the key, and a consumer that
      //     tests `candidates !== undefined` would treat [] as uncertainty.
      //   non-empty + a provenance other than `dynamic-candidate` -> ERROR.
      //     METAMODEL.md §4 pairs them ("uncertain dispatch -> provenance:
      //     dynamic-candidate + candidates list"), and a guess recorded as a
      //     `declared` fact is exactly the fact/inference mixing CLAUDE.md
      //     invariant 2 forbids.
      //   `dynamic-candidate` with no candidates -> WARNING, not an error: an
      //     unresolvable dispatch with a single plausible target has the
      //     one-element list {to}, which an extractor may omit as redundant.
      //   `to` not among the candidates -> WARNING: §4 calls `to` the "best
      //     candidate if uncertain", so its absence usually means the two were
      //     filled from different resolution passes.
      const candidates = edge.candidates;
      if (candidates !== undefined && candidates.length === 0) {
        at(
          "error",
          "candidates",
          "candidates-empty",
          `${path}.candidates`,
          edge.from,
          `${path} (${edge.from} -> ${edge.to}) carries an empty candidates array; omit the key when resolution was certain`,
        );
      } else if (candidates !== undefined && provenance !== "dynamic-candidate") {
        at(
          "error",
          "candidates",
          "candidates-without-uncertainty",
          `${path}.candidates`,
          edge.from,
          `${path} (${edge.from} -> ${edge.to}) lists ${candidates.length} candidates but is provenance "${String(provenance)}"; candidates mean ambiguous dispatch, which is provenance "dynamic-candidate"`,
        );
      }
      // NOT CHECKED: `to` among its own `candidates`.
      //
      // §4 calls `to` the "best candidate if uncertain", which reads as though
      // it must appear in the list. Measured against real Spoon output
      // (commons-lang, 361 dynamic-candidate edges): 242 include `to` and 119
      // do not, and every one of the 119 resolves to a declaration that cannot
      // itself execute — an interface method, an abstract method, or an enum
      // constant body's supertype, whose `candidates` are the concrete
      // overriders. Excluding it is the MORE precise answer: the list means
      // "what could actually run".
      //
      // The model records no abstractness, so this checker cannot tell a
      // correct exclusion from a mistaken one. A rule that fired on all 119 of
      // the reference corpus's correct edges would only teach readers to
      // ignore warnings, so the honest move is not to assert it at all.
      // Re-instating it requires a modifier/abstractness fact in the metamodel.
      if (provenance === "dynamic-candidate" && candidates === undefined) {
        at(
          "warning",
          "candidates",
          "candidates-missing",
          path,
          edge.from,
          `${path} (${edge.from} -> ${edge.to}) is provenance "dynamic-candidate" but lists no candidates; the alternatives it was chosen from are lost`,
        );
      }

      // Evidence everywhere (CLAUDE.md invariant 3): an edge without an anchor
      // is an unauditable claim.
      checkAnchor(edge.anchor, path, edge.from, at, `${edge.edge} edge ${edge.from} -> ${edge.to}`);
    });

    // Entity anchors are optional (TSourceAnchor); when present they obey the
    // same span rules.
    model.entities.forEach((entity, index) => {
      const path = `entities[${index}]`;
      if (entity.traits.includes("TSourceAnchor")) {
        checkAnchor(
          (entity as { anchor?: unknown }).anchor,
          path,
          entity.id,
          at,
          `entity "${entity.id}"`,
        );
      }
      const sites = declarations.get(entity.id);
      const site: DeclarationSite = { modelIndex, label, path, entity };
      if (sites === undefined) declarations.set(entity.id, [site]);
      else sites.push(site);
    });

    // ---- PROFILE VALIDITY ---------------------------------------------------
    // `validateModel` runs `validateEntity` on every entity and adds the
    // model-level rules (licensed edge kinds, lang match). Codes a dedicated
    // rule above owns are skipped so nothing is counted twice.
    const profile = getProfile(model.lang);
    if (profile === undefined) {
      unknownProfiles.add(model.lang);
      at(
        "warning",
        "profile",
        "unknown-profile",
        "lang",
        undefined,
        `no profile is registered for lang "${model.lang}", so profile validity was not checked for this model`,
      );
    } else {
      for (const issue of validateModel(model, profile)) {
        if (OWNED_BY_ANOTHER_RULE.has(issue.code)) continue;
        // Core sets `path` to the entity id for entity-level issues; keep it as
        // the path AND surface it as the id so the message always names the
        // offender.
        const id = known.has(issue.path) ? issue.path : undefined;
        at(
          "error",
          "profile",
          issue.code as ConformanceCode,
          issue.path,
          id,
          id === undefined ? issue.message : `${id}: ${issue.message}`,
        );
      }
    }
  });

  // ---- DUPLICATE IDS THAT DISAGREE ------------------------------------------
  // Union-wide, because the same id can be declared by two models. Identical
  // redeclaration is legal (METAMODEL.md §1.1); disagreement is not.
  for (const id of [...declarations.keys()].sort(compareIds)) {
    const sites = declarations.get(id) ?? [];
    if (sites.length < 2) continue;
    const first = sites[0];
    if (first === undefined) continue;
    const conflicting = sites.filter((site) => !sameEntityDeclaration(first.entity, site.entity));
    if (conflicting.length === 0) continue;
    const where = sites
      .map((site) => `${site.label}:${site.path} kind "${site.entity.kind}" ${traitList(site.entity)}`)
      .join("; ");
    findings.add({
      severity: "error",
      rule: "duplicate-id",
      code: "duplicate-id-conflict",
      modelIndex: first.modelIndex,
      label: first.label,
      path: first.path,
      id,
      message: `id "${id}" is declared ${sites.length} times and the declarations disagree on kind or traits — ${where}`,
    });
  }

  const all = findings.sorted();
  const kept = truncate(all, options.maxPerRule ?? 0);
  const counts = countFindings(all, all.length - kept.length);

  return {
    ok: counts.errors === 0,
    findings: kept,
    counts,
    subject: {
      models: union.models.length,
      entities: union.entities.length,
      stubs: union.entities.filter(isStubEntity).length,
      edges: union.edges.length,
      langs: union.langs,
      sources: union.sources.map((source) => source.label),
      unknownProfiles: [...unknownProfiles].sort(compareIds),
    },
  };
}

interface DeclarationSite {
  readonly modelIndex: number;
  readonly label: string;
  readonly path: string;
  readonly entity: Entity;
}

type Reporter = (
  severity: ConformanceSeverity,
  rule: ConformanceRule,
  code: ConformanceCode,
  path: string,
  id: EntityId | undefined,
  message: string,
) => void;

/** Anchors are evidence: a file and a 1-based, ordered, inclusive line span. */
function checkAnchor(
  anchor: unknown,
  path: string,
  id: EntityId,
  at: Reporter,
  subject: string,
): void {
  if (!isAnchor(anchor)) {
    at("error", "anchor", "missing-anchor", `${path}.anchor`, id, `${subject} has no usable anchor {file, span}`);
    return;
  }
  if (anchor.file.trim() === "") {
    at("error", "anchor", "anchor-file-empty", `${path}.anchor.file`, id, `${subject} has an empty anchor file`);
  }
  const [start, end] = anchor.span;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
    at(
      "error",
      "anchor",
      "anchor-span-not-1-based",
      `${path}.anchor.span`,
      id,
      `${subject} has span [${String(start)}, ${String(end)}]; line numbers are 1-based integers`,
    );
    return;
  }
  if (start > end) {
    at(
      "error",
      "anchor",
      "anchor-span-reversed",
      `${path}.anchor.span`,
      id,
      `${subject} has span [${start}, ${end}], which ends before it starts`,
    );
  }
}

/** Counts the FULL finding list, so a cap never makes a corpus look healthier. */
function countFindings(findings: readonly ConformanceFinding[], suppressed: number): ConformanceCounts {
  const byCode: Record<string, number> = Object.create(null) as Record<string, number>;
  const byRule = Object.fromEntries(CONFORMANCE_RULES.map((rule) => [rule, 0])) as Record<
    ConformanceRule,
    number
  >;
  let errors = 0;
  let warnings = 0;

  for (const finding of findings) {
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    byRule[finding.rule] += 1;
    if (finding.severity === "error") errors += 1;
    else warnings += 1;
  }

  return { errors, warnings, byCode: Object.freeze(byCode), byRule: Object.freeze(byRule), suppressed };
}

function truncate(findings: readonly ConformanceFinding[], maxPerRule: number): readonly ConformanceFinding[] {
  if (maxPerRule <= 0) return findings;
  const seen = new Map<ConformanceRule, number>();
  return findings.filter((finding) => {
    const count = (seen.get(finding.rule) ?? 0) + 1;
    seen.set(finding.rule, count);
    return count <= maxPerRule;
  });
}
