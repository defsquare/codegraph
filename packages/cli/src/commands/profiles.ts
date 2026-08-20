import { compareIds, toJsonString } from "@codegraph/analyzer";
import { PROFILES, getProfile, type Profile } from "@codegraph/core";
import type { ProfilesOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";

/**
 * M4 SEAM — `codegraph profiles [--lang java] [--json]`.
 *
 * The contract this implementation must honour:
 *  - Read `PROFILES` / `getProfile(lang)` from `@codegraph/core`. Profiles are
 *    DATA (CLAUDE.md invariant 8): print them, never synthesize one.
 *  - No `--lang`: list every shipped profile. With `--lang`: print that
 *    profile's kinds (required/optional traits), edge kinds, spaces and notes.
 *  - An unknown `--lang` is a USAGE error (exit 2) naming the languages that do
 *    exist — no model was involved, so it cannot be a finding.
 *  - `--json` prints the profile object(s) on stdout; deterministic key and
 *    array order.
 *  - This command reads no model, so its only success code is `EXIT.OK`.
 *
 * WHO READS THIS: an extractor author deciding what their language's contract
 * IS, and an analyst deciding whether to trust a number. Both are served by
 * completeness, not brevity — which is why `--lang` prints every kind with its
 * full trait composition and every `note` VERBATIM. The notes are the
 * documented static-analysis blind spots (reflection, macros, `any`-typed
 * receivers); a truncated blind spot is worse than none, because it reads as
 * the whole list.
 *
 * Notes are printed UNWRAPPED, one per line. They are long, but a terminal
 * soft-wraps them for free while a hard wrap would break `grep 'Reflection is
 * invisible'` and turn every note edit into a re-flowed diff. Output here is a
 * data artifact first (decision 3) and prose second.
 */
export function profilesCommand(options: ProfilesOptions, io: IoSink): ExitCode {
  const profiles = shippedProfiles();

  if (options.lang === undefined) {
    if (options.json) {
      io.out(toJsonString(profiles.map(canonicalProfile)));
    } else {
      outLines(io, summaryLines(profiles));
      // Human, therefore stderr: the table above must survive `| column -t`
      // and a redirect with nothing appended to it.
      errLine(
        io,
        `${profiles.length} profiles. Run 'codegraph profiles --lang <lang>' for one language's full spec.`,
      );
    }
    return EXIT.OK;
  }

  const profile = getProfile(options.lang);
  if (profile === undefined) {
    // A language core does not ship is a mistake in the INVOCATION, not a
    // finding: no model was read, so there is nothing to have findings about.
    throw new UsageError(
      `unknown language '${options.lang}'`,
      `Profiles core ships: ${profiles.map((p) => p.lang).join(", ")}.`,
    );
  }

  if (options.json) io.out(toJsonString(canonicalProfile(profile)));
  else outLines(io, specLines(profile));
  return EXIT.OK;
}

/** Every shipped profile, ordered by lang — never by `PROFILES` iteration order. */
function shippedProfiles(): readonly Profile[] {
  return [...Object.values(PROFILES)].sort((a, b) => compareIds(a.lang, b.lang));
}

function countOf(record: Readonly<Record<string, unknown>>): number {
  return Object.keys(record).length;
}

function sortedKinds(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).sort(compareIds);
}

/** `TNamed, TType, TChildOf` — or an explicit `(none)`, never an empty column. */
function list(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * The index: one line per profile, aligned so the counts can be read down the
 * column and the edge vocabularies compared at a glance. `edges` prints in the
 * order the profile declares it — that order is data too, and re-sorting it
 * would show a contract the profile does not state.
 */
function summaryLines(profiles: readonly Profile[]): readonly string[] {
  const rows = profiles.map((profile) => ({
    lang: profile.lang,
    kinds: String(countOf(profile.kinds)),
    notes: String(profile.notes?.length ?? 0),
    edges: list([...profile.edges]),
  }));

  const header = { lang: "lang", kinds: "kinds", notes: "notes", edges: "edge kinds" };
  const langWidth = Math.max(...rows.map((row) => row.lang.length), header.lang.length);
  const kindsWidth = Math.max(...rows.map((row) => row.kinds.length), header.kinds.length);
  const notesWidth = Math.max(...rows.map((row) => row.notes.length), header.notes.length);

  const render = (row: { lang: string; kinds: string; notes: string; edges: string }): string =>
    [
      padEnd(row.lang, langWidth),
      padStart(row.kinds, kindsWidth),
      padStart(row.notes, notesWidth),
      row.edges,
    ].join("  ");

  return [render(header), ...rows.map(render)];
}

/**
 * The full spec for one language: every kind with its licit trait composition,
 * the licensed edge kinds, the declaration spaces where the profile declares
 * any, and the notes in full.
 *
 * Kinds are printed in sorted order so the same profile always renders the same
 * bytes and two languages can be diffed against each other; trait lists print
 * as declared, because `required ⊆ traits ⊆ required ∪ optional` says nothing
 * about order and the authored grouping is the more readable one.
 */
function specLines(profile: Profile): readonly string[] {
  const lines: string[] = [];
  const noteCount = profile.notes?.length ?? 0;

  lines.push(`profile: ${profile.lang}`);
  lines.push(
    `summary: ${countOf(profile.kinds)} kinds, ${profile.edges.length} edge kinds, ${noteCount} notes`,
  );
  lines.push("");
  lines.push(`edge kinds: ${list([...profile.edges])}`);
  lines.push("");
  lines.push("kinds:");

  for (const kind of sortedKinds(profile.kinds)) {
    const spec = profile.kinds[kind];
    if (spec === undefined) continue;
    lines.push(`  ${kind}`);
    lines.push(`    required  ${list([...spec.required])}`);
    lines.push(`    optional  ${list([...spec.optional])}`);
    // Only the TypeScript family declares `space` (METAMODEL.md §1.4); its
    // absence is the profile stating that the language has no type/value split,
    // so nothing is printed rather than an empty or invented line.
    const spaces = profile.space?.[kind];
    if (spaces !== undefined) lines.push(`    space     ${list([...spaces])}`);
  }

  lines.push("");
  lines.push("notes:");
  if (noteCount === 0) {
    lines.push("  (none)");
  } else {
    for (const note of profile.notes ?? []) lines.push(`  - ${note}`);
  }

  return lines;
}

/**
 * The profile as JSON: the same data, with a canonical key and kind order so
 * that identical inputs produce byte-identical stdout (decision 6). Nothing is
 * added, renamed or defaulted — `space` and `notes` stay absent where the
 * profile omits them, because their absence is itself profile information.
 */
function canonicalProfile(profile: Profile): Record<string, unknown> {
  const kinds: Record<string, unknown> = {};
  for (const kind of sortedKinds(profile.kinds)) {
    const spec = profile.kinds[kind];
    if (spec === undefined) continue;
    kinds[kind] = { required: spec.required, optional: spec.optional };
  }

  const out: Record<string, unknown> = {
    lang: profile.lang,
    kinds,
    edges: profile.edges,
  };

  if (profile.space !== undefined) {
    const space: Record<string, unknown> = {};
    for (const kind of sortedKinds(profile.space)) {
      const spaces = profile.space[kind];
      if (spaces !== undefined) space[kind] = spaces;
    }
    out["space"] = space;
  }
  if (profile.notes !== undefined) out["notes"] = profile.notes;

  return out;
}
