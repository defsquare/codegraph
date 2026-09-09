import type { BuildingSource } from "@codegraph/city";
import type { DistrictArc } from "./districtArrows.js";
import type { BuildingBox } from "./buildings.js";
import type { Plate } from "./districts.js";
import { districtLabel } from "./labels.js";
import { sourceUrl, type RepositoryFacts } from "./source.js";

/**
 * The click panel's data, DOM-free: what the shell prints when a building or
 * district is selected. The arithmetic the hover tooltip used to inline
 * (children counts, fan sums) lives here, tested, and the DOM layer only
 * renders rows. `unmeasured` keeps its own class so a missing measurement can
 * never be styled as a value (CLAUDE.md: honesty).
 */
export interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly className?: string;
}

export interface DistrictDetails {
  /** The module's entity id — what "Open in navigator" hands over. */
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly rows: readonly DetailRow[];
}

export interface BuildingDetails {
  /** The type's entity id — what "Open in navigator" hands over. */
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly rows: readonly DetailRow[];
  readonly attributes: BuildingBox["attributes"];
  readonly operations: BuildingBox["operations"];
  /**
   * "View source", when the artifact says where the corpus lives AND the model
   * anchored this building. Absent means absent: no link beats a link that
   * 404s (M10a).
   */
  readonly link?: { readonly url: string; readonly label: string };
}

export function districtDetails(
  plates: readonly Plate[],
  boxes: readonly BuildingBox[],
  arcs: readonly DistrictArc[],
  plate: Plate,
): DistrictDetails {
  const buildings = boxes.filter((box) => box.district === plate.id).length;
  const nested = plates.filter((candidate) => candidate.parent === plate.id).length;
  const fanIn = arcs.filter((arc) => arc.to === plate.id);
  const fanOut = arcs.filter((arc) => arc.from === plate.id);
  const sum = (fan: readonly DistrictArc[]): number =>
    fan.reduce((total, arc) => total + arc.count, 0);
  return {
    id: plate.id,
    title: districtLabel(plate),
    meta:
      `module${plate.isStub ? " (stub)" : ""}` +
      `${plate.parent === undefined ? "" : ` — in ${plate.parent}`}`,
    rows: [
      { label: "buildings", value: String(buildings) },
      { label: "nested districts", value: String(nested) },
      { label: "fan-in", value: `${fanIn.length} modules / ${sum(fanIn)} deps` },
      { label: "fan-out", value: `${fanOut.length} modules / ${sum(fanOut)} deps` },
    ],
  };
}

/**
 * How the panel prints one operation: the name apart (the shell bolds it),
 * then the parameter list. With the artifact's declared parameters it is
 * `name: Type` pairs (a parameter whose type did not resolve shows its name
 * alone); without them it falls back to the signature's type list. Either
 * way `java.lang.*` / `java.util.*` types — subpackages included — shorten
 * to their symbol name: those packages are ubiquitous noise (`String`,
 * `List`, `Function`); every other package stays whole because it is what
 * distinguishes two same-named types.
 */
export function operationDisplay(
  signature: string,
  parameters?: BuildingBox["operations"][number]["parameters"],
): { name: string; params: string } {
  const paren = signature.indexOf("(");
  const name = paren < 0 ? signature : signature.slice(0, paren);
  const raw =
    parameters === undefined
      ? paren < 0
        ? ""
        : signature.slice(paren)
      : `(${parameters
          .map((p) => (p.type === undefined ? p.name : `${p.name}: ${p.type}`))
          .join(", ")})`;
  return { name, params: shortenUbiquitous(raw) };
}

function shortenUbiquitous(params: string): string {
  return params.replace(/\bjava\.(?:lang|util)(?:\.[a-z][\w$]*)*\.(?=[A-Z])/g, "");
}

/**
 * The operations the panel lists: named ones through `operationDisplay`, in
 * order; the nameless — lambdas and other anonymous invocables, whose
 * signature starts at the parameter list — only as a count. 387 identical
 * `()` bullets name nothing; one honest count line does.
 */
export function operationList(operations: BuildingBox["operations"]): {
  items: readonly { name: string; params: string }[];
  anonymous: number;
} {
  const named = operations.filter((operation) => !operation.signature.startsWith("("));
  return {
    items: named.map((operation) => operationDisplay(operation.signature, operation.parameters)),
    anonymous: operations.length - named.length,
  };
}

/**
 * The panel's data for one building. `at` is the artifact's repository facts
 * plus the commit to link AT — the scrubbed tick's sha in a replay, so the
 * permalink follows the city instead of the latest snapshot.
 */
export function buildingDetails(
  box: BuildingBox,
  at: { repository?: RepositoryFacts | undefined; commit?: string | undefined } = {},
): BuildingDetails {
  const url = sourceUrl(at.repository, box.source, at.commit ?? at.repository?.commit ?? "");
  return {
    ...(url === undefined || box.source === undefined
      ? {}
      : { link: { url, label: sourceLabel(box.source) } }),
    id: box.id,
    title: box.name ?? box.id,
    // The module component when the artifact gives it; the district id is the
    // opaque fallback for artifacts from before `identity` existed.
    meta:
      `${box.kind}${box.isStub ? " (stub)" : ""} — ` +
      `${box.identity?.module ?? box.district}`,
    rows: [
      ...Object.entries(box.metrics).map(([metric, value]) =>
        value === null
          ? { label: metric, value: "unmeasured", className: "unmeasured" }
          : { label: metric, value: String(value) },
      ),
      // The history join's inference, labeled as such: dominant author of the
      // element's file, with the share of all added lines that makes it so.
      ...(box.owner === undefined
        ? []
        : [
            {
              label: "owner",
              value: `${box.owner.name.split(" <")[0] ?? box.owner.name} (${Math.round(box.owner.share * 100)}% of added lines)`,
            },
          ]),
    ],
    attributes: box.attributes,
    operations: box.operations,
  };
}

/** What the link says it opens: the anchor, verbatim, path and lines. */
function sourceLabel(source: BuildingSource): string {
  if (source.span === undefined) return source.file;
  const [start, end] = source.span;
  return `${source.file}:${start}${end > start ? `-${end}` : ""}`;
}
