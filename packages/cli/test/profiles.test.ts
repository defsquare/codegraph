import { PROFILES, getProfile, type Profile } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { profilesCommand } from "../src/commands/profiles.js";
import { EXIT, isUsageError } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph profiles` is how an extractor author discovers what a language's
 * contract IS, so the tests here are mostly completeness tests: every kind,
 * every edge kind and every note must survive to stdout intact. A profile
 * printed with its blind spots trimmed is worse than one not printed at all —
 * a truncated list of what the analysis cannot see reads as the whole list.
 */

const LANGS = Object.keys(PROFILES).sort();

function invoke(argv: readonly string[]): { code: number; io: CapturedIo } {
  const io = captureIo();
  return { code: run(argv, io), io };
}

function profileOf(lang: string): Profile {
  const profile = getProfile(lang);
  if (profile === undefined) throw new Error(`no profile for ${lang}`);
  return profile;
}

describe("the listing", () => {
  it("names all nine profiles, one line each, with counts and edge kinds", () => {
    const { code, io } = invoke(["profiles"]);
    expect(code).toBe(EXIT.OK);

    const lines = io.stdoutLines();
    expect(lines[0]).toContain("lang");
    expect(lines).toHaveLength(LANGS.length + 1);

    for (const lang of LANGS) {
      const profile = profileOf(lang);
      const row = lines.find((line) => line.startsWith(lang));
      expect(row, `no row for ${lang}`).toBeDefined();
      expect(row).toContain(String(Object.keys(profile.kinds).length));
      for (const edge of profile.edges) expect(row).toContain(edge);
    }
  });

  it("lists the profiles in a stable, sorted order", () => {
    const langsInOutput = invoke(["profiles"])
      .io.stdoutLines()
      .slice(1)
      .map((line) => line.split(/\s+/)[0]);
    expect(langsInOutput).toEqual(LANGS);
  });

  it("keeps the pointer to the full spec on stderr, out of the table", () => {
    const { io } = invoke(["profiles"]);
    expect(io.stderr()).toContain("--lang");
    // The table is the artifact; nothing human may share the stream with it.
    expect(io.stdout()).not.toContain("Run 'codegraph");
  });
});

describe("one language's full spec", () => {
  it("prints every kind with its required and optional traits", () => {
    const profile = profileOf("java");
    const { code, io } = invoke(["profiles", "--lang", "java"]);
    expect(code).toBe(EXIT.OK);
    const out = io.stdout();

    for (const [kind, spec] of Object.entries(profile.kinds)) {
      expect(out, `kind ${kind} missing`).toContain(`  ${kind}\n`);
      for (const trait of [...spec.required, ...spec.optional]) {
        expect(out, `trait ${trait} of ${kind} missing`).toContain(trait);
      }
    }
    expect(out).toContain("required");
    expect(out).toContain("optional");
  });

  it("prints the licensed edge kinds", () => {
    const profile = profileOf("java");
    const out = invoke(["profiles", "--lang", "java"]).io.stdout();
    for (const edge of profile.edges) expect(out).toContain(edge);
  });

  /**
   * The notes ARE the documented static-analysis blind spots (reflection,
   * `any`-typed receivers, macro expansion). Someone deciding whether to trust
   * a coupling number reads them, so every one must appear verbatim — no
   * ellipsis, no wrapping, no "and 9 more".
   */
  it.each(LANGS)("prints %s's notes verbatim and in full", (lang) => {
    const profile = profileOf(lang);
    const lines = invoke(["profiles", "--lang", lang]).io.stdoutLines();
    const notes = profile.notes ?? [];
    // Line-for-line, not substring-for-substring: a note that arrived wrapped,
    // clipped or merged with the next one would still pass a `toContain`.
    expect(lines.filter((line) => line.startsWith("  - "))).toEqual(
      notes.map((note) => `  - ${note}`),
    );
  });

  it("prints the declaration spaces exactly where a profile declares them", () => {
    const ts = invoke(["profiles", "--lang", "ts"]).io.stdout();
    expect(ts).toContain("space");
    const spaces = profileOf("ts").space ?? {};
    for (const [kind, licensed] of Object.entries(spaces)) {
      expect(ts, `space for ${kind}`).toContain(`space     ${licensed.join(", ")}`);
    }

    // Absence of `space` is profile information (METAMODEL.md §1.4): a language
    // with no type/value split must not be shown an empty or invented column.
    for (const lang of LANGS) {
      if (profileOf(lang).space !== undefined) continue;
      expect(invoke(["profiles", "--lang", lang]).io.stdout()).not.toContain("\n    space ");
    }
  });
});

describe("--json prints the profile data as-is", () => {
  // The artifact is the object `{kind, profiles[]}` in BOTH forms (decision 8
  // says object; the other commands all stamp a `kind`). `--lang` filters
  // `profiles` rather than switching to a second shape, so these assertions
  // read the payload — the "loses and invents nothing" property is unchanged.
  function payload(argv: readonly string[]): readonly unknown[] {
    const parsed = JSON.parse(invoke([...argv, "--json"]).io.stdout()) as Record<string, unknown>;
    expect(parsed["kind"], "the --json artifact must identify itself").toBe("codegraph.profiles/1");
    const profiles = parsed["profiles"];
    expect(Array.isArray(profiles)).toBe(true);
    return profiles as readonly unknown[];
  }

  it("emits one profile object for --lang, losing and inventing nothing", () => {
    const { code, io } = invoke(["profiles", "--lang", "java", "--json"]);
    expect(code).toBe(EXIT.OK);
    expect(payload(["profiles", "--lang", "java"])).toEqual([
      JSON.parse(JSON.stringify(profileOf("java"))),
    ]);
    expect(io.stderr()).toBe("");
  });

  it("emits every profile, in lang order, when no --lang is given", () => {
    expect(payload(["profiles"])).toEqual(
      LANGS.map((lang) => JSON.parse(JSON.stringify(profileOf(lang)))),
    );
  });

  it("says the same thing as the text form (decision 8)", () => {
    const text = invoke(["profiles", "--lang", "go"]).io.stdout();
    const [json] = payload(["profiles", "--lang", "go"]) as readonly Profile[];
    expect(json?.lang).toBe("go");
    for (const kind of Object.keys(json?.kinds ?? {})) expect(text).toContain(kind);
    for (const note of json?.notes ?? []) expect(text).toContain(note);
  });
});

describe("an unknown language is a usage error, not a finding", () => {
  it("exits 2 and names the languages that do exist", () => {
    const { code, io } = invoke(["profiles", "--lang", "cobol"]);
    expect(code).toBe(EXIT.USAGE);
    expect(code).not.toBe(EXIT.FINDINGS);
    // No model was read, so nothing about a model can be claimed — and the
    // artifact stream stays empty.
    expect(io.stdout()).toBe("");
    for (const lang of LANGS) expect(io.stderr()).toContain(lang);
  });

  it("raises it as a UsageError so main owns the prefix and the code", () => {
    let thrown: unknown;
    try {
      profilesCommand({ lang: "cobol", json: false }, captureIo());
    } catch (error) {
      thrown = error;
    }
    expect(isUsageError(thrown)).toBe(true);
    expect((thrown as Error).message).not.toContain("codegraph:");
  });
});

describe("output discipline", () => {
  const invocations: readonly (readonly string[])[] = [
    ["profiles"],
    ["profiles", "--json"],
    ["profiles", "--lang", "java"],
    ["profiles", "--lang", "java", "--json"],
    ["profiles", "--lang", "ts", "--json"],
  ];

  it.each(invocations)("codegraph %s is byte-identical across runs", (...argv) => {
    const first = invoke(argv);
    const second = invoke(argv);
    expect(first.io.stdout()).toBe(second.io.stdout());
    expect(first.io.stderr()).toBe(second.io.stderr());
    expect(first.code).toBe(second.code);
  });

  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[/;

  it.each(invocations)("codegraph %s emits no ANSI escape (decision 4)", (...argv) => {
    const { io } = invoke(argv);
    expect(ANSI.test(io.stdout())).toBe(false);
    expect(ANSI.test(io.stderr())).toBe(false);
  });

  it("writes no file and touches no model", () => {
    const { io } = invoke(["profiles", "--lang", "rust"]);
    expect(io.files().size).toBe(0);
  });

  it("ends stdout with exactly one trailing newline", () => {
    for (const argv of invocations) {
      const out = invoke(argv).io.stdout();
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n\n")).toBe(false);
    }
  });
});
