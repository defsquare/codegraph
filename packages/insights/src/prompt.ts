import type { ContextPack, DependencySummary, MemberPack } from "./context.js";
import { responseSchemaName } from "./schema.js";
import type { WalkSpec } from "./spec.js";

/**
 * THE PROMPT. One system message per level and shape, the walk's spec's to
 * write; one user message laid out in fixed Markdown sections so the model
 * always finds the same thing in the same place — the engine's, and not a
 * spec's to rearrange: a spec only closes a member's section with lines of
 * its own. Deterministic: the same pack renders the same bytes.
 *
 * SOURCE IS DATA. Everything that came from the corpus — source text, Javadoc,
 * identifiers — is fenced with a four-backtick fence and the system message
 * says that fenced content is material to describe, never instructions to
 * follow. That is the whole defence against a comment reading "ignore the
 * rules above": it stays inside the fence, and the model is told what the
 * fence means.
 */

export interface Prompt {
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly shape: "block" | "scc";
  /** The member ids this prompt must return a block for (the whole unit, or one chunk of a large cycle). */
  readonly memberIds: readonly string[];
  /** What it asks to define: words over its members, and a module's glossary entries — for the estimate. */
  readonly asked: { readonly words: number; readonly glossary: number };
}

/** The corpus fence. A system message that says what fenced text is quotes this. */
export const FENCE = "````";

/** A crude, provider-independent estimate: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fenced(text: string, language = ""): string {
  return `${FENCE}${language}\n${text.replace(/````/gu, "'''' ")}\n${FENCE}`;
}

function summaryLines(items: readonly DependencySummary[], indent: string): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const head = `${indent}- ${item.name} [${item.level}${item.concept === undefined ? "" : `, ${item.concept}`}] (${item.id})`;
    lines.push(item.missing ? `${head}: NOT EXPLAINED` : `${head}: ${item.summary.replace(/\s+/gu, " ").trim()}`);
    lines.push(...summaryLines(item.children, `${indent}  `));
  }
  return lines;
}

function memberSection(member: MemberPack, full: boolean, spec: WalkSpec): string[] {
  const lines: string[] = [];
  const where = [member.containingType === undefined ? undefined : `in type ${member.containingType}`, member.containingModule === undefined ? undefined : `in module ${member.containingModule}`]
    .filter((s): s is string => s !== undefined)
    .join(", ");
  lines.push(`### ${member.kind} \`${member.name}\` (${member.id})${where === "" ? "" : ` — ${where}`}`);
  if (member.signature !== undefined) lines.push(`Signature: ${fenced(member.signature)}`);
  if (member.annotations.length > 0) lines.push(`Annotations: ${member.annotations.join(" ")}`);
  const facts: string[] = [];
  if (member.stereotype !== undefined) facts.push(`framework stereotype: ${member.stereotype}`);
  if (member.entryPoint) facts.push("framework entry point (nothing in the corpus calls it)");
  if (member.metrics !== undefined) facts.push(`metrics: ${Object.entries(member.metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (facts.length > 0) lines.push(facts.join("; "));
  if (!full) return lines;

  if (member.comments.length > 0) lines.push("Documentation:", fenced(member.comments.join("\n\n")));
  if (member.source !== undefined) {
    const label = `Source (${member.source.file}:${member.source.span[0]}-${member.source.span[1]}${member.source.truncated ? ", middle elided" : ""})`;
    lines.push(member.source.missing ? `${label}: source unavailable` : `${label}:`, ...(member.source.missing ? [] : [fenced(member.source.text, member.lang ?? "")]));
  }
  if (member.supertypes.length > 0) {
    lines.push("Supertypes:", ...member.supertypes.map((s) => `- ${s.relation === "inheritance" ? "extends" : "implements"} ${s.name}${s.external ? " (external)" : ""}`));
  }
  if (member.fields.length > 0) {
    lines.push(
      "Fields:",
      ...member.fields.map((f) => {
        const type = f.type === undefined ? "" : `: ${f.type}${f.typeKind === undefined ? "" : ` (${f.typeKind}${f.external ? ", external" : ""})`}`;
        const value = f.value === undefined ? "" : ` = ${f.value}`;
        const ann = f.annotations.length === 0 ? "" : ` ${f.annotations.join(" ")}`;
        return `- ${f.name}${type}${value}${ann}`;
      }),
    );
  }
  if (member.injectionPoints.length > 0) {
    lines.push("Injected by the container:", ...member.injectionPoints.map((p) => `- ${p.name}${p.declaredType === undefined ? "" : `: ${p.declaredType}`}${p.candidates.length === 0 ? "" : ` ← ${p.candidates.join(" | ")}`}`));
  }
  if (member.calls.length > 0) {
    lines.push("Calls:", ...member.calls.map((c) => `- ${c.target}${c.targetType === undefined ? "" : ` of ${c.targetType}`}${c.stereotype === undefined ? "" : ` [${c.stereotype}]`} (${c.external ? "external" : "corpus"}${c.provenance === "declared" ? "" : `, ${c.provenance}`})`));
  }
  if (member.accesses.length > 0) {
    lines.push("Field accesses:", ...member.accesses.map((a) => `- ${a.mode} ${a.ownerType === undefined ? "" : `${a.ownerType}.`}${a.field}${a.external ? " (external)" : ""}`));
  }
  if (member.throws.length > 0) lines.push("Throws:", ...member.throws.map((t) => `- ${t.name}${t.external ? " (external)" : ""}`));
  if (member.imports.length > 0) lines.push("Imports:", ...member.imports.map((i) => `- ${i.name} ×${i.count}${i.external ? " (external)" : ""}`));
  if (member.parts.length > 0) {
    lines.push(member.level === "module" ? "Types in this module, as already explained:" : "Members, as already explained:", ...summaryLines(member.parts, ""));
  }
  lines.push(...spec.memberLines(member));
  return lines;
}

/**
 * Distinct words over the members a prompt fully shows, and the glossary
 * entries it asks for — counting, in a plan, a word a type still to explain
 * may define, since the prompt sent after it may list it.
 */
function askedOf(members: readonly MemberPack[]): Prompt["asked"] {
  return {
    words: members.reduce((sum, m) => sum + new Set(m.names.flatMap((n) => n.words)).size, 0),
    glossary: members.reduce((sum, m) => sum + m.glossary.filter((g) => g.entries.length > 0 || g.pending).length, 0),
  };
}

function userPrompt(pack: ContextPack, full: readonly MemberPack[], signaturesOnly: readonly MemberPack[]): string {
  const lines: string[] = [];
  lines.push(`# Unit: ${pack.level} ${pack.unit.id}${pack.unit.members.length > 1 ? ` (a cycle of ${pack.unit.members.length} ${pack.level}s)` : ""}`);
  lines.push("");
  lines.push(full.length > 1 || signaturesOnly.length > 0 ? "## Cycle members" : "## The unit");
  if (full.length > 1 || signaturesOnly.length > 0) {
    lines.push(`Return one entry per id: ${full.map((m) => m.id).join(", ")}.`);
    lines.push("");
  }
  for (const member of full) lines.push(...memberSection(member, true, pack.spec), "");
  if (signaturesOnly.length > 0) {
    lines.push("## Other members of this cycle (signatures only, explained separately)");
    for (const member of signaturesOnly) lines.push(...memberSection(member, false, pack.spec));
    lines.push("");
  }
  lines.push("## What the dependencies do");
  lines.push(pack.dependencies.length === 0 ? "(no dependencies inside the corpus)" : summaryLines(pack.dependencies, "").join("\n"));
  lines.push("");
  return lines.join("\n");
}

/**
 * One prompt per unit — or, for a cycle larger than `maxScc`, one per chunk of
 * `maxScc` members, each seeing the other members' signatures only. Deterministic.
 */
export function renderPrompts(pack: ContextPack, maxScc: number): Prompt[] {
  const members = pack.members;
  if (members.length <= Math.max(1, maxScc)) {
    const shape = members.length > 1 ? "scc" : "block";
    return [
      {
        system: pack.spec.system(pack.level, shape),
        user: userPrompt(pack, members, []),
        schemaName: responseSchemaName(pack.level, shape),
        shape,
        memberIds: members.map((m) => m.id),
        asked: askedOf(members),
      },
    ];
  }
  const prompts: Prompt[] = [];
  const size = Math.max(1, maxScc);
  for (let start = 0; start < members.length; start += size) {
    const chunk = members.slice(start, start + size);
    const rest = [...members.slice(0, start), ...members.slice(start + size)];
    prompts.push({
      system: pack.spec.system(pack.level, "scc"),
      user: userPrompt(pack, chunk, rest),
      schemaName: responseSchemaName(pack.level, "scc"),
      shape: "scc",
      memberIds: chunk.map((m) => m.id),
      asked: askedOf(chunk),
    });
  }
  return prompts;
}
