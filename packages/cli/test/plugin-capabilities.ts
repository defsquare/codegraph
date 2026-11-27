import { join } from "node:path";
import { PROFILES, parseRenderedId, readModelFileSync, type Profile } from "@codegraph/core";
import { FRAMEWORK_PROFILES } from "@codegraph/analyzer";
import { REPO_ROOT, readRepo } from "./plugin-support.js";

/**
 * `plugin/references/capabilities.md`, RENDERED FROM DATA (PLAN.md §24.1).
 *
 * The walk's sixth principle is that an agent says what the tool does not do
 * for a language before the person finds out. It can only say what it was
 * told, and a hand-written table of "what each extractor gives" would be the
 * first thing to go stale: profiles gain kinds, a framework gains a profile,
 * an extractor gains a trace. So the sheet is a rendering of what the code
 * itself declares — the language profiles (core), the framework profiles
 * (analyzer) and the extractor catalogue the desktop app ships — and
 * `plugin-capabilities.test.ts` fails when rendering it again changes it.
 *
 * It lives beside the tests because the plugin is text with no build step and
 * no dependency: nothing in `plugin/` may import a package.
 */

export interface CatalogueEntry {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly command: string;
  readonly install: string;
  readonly role?: string;
}

export const CATALOGUE_PATH = "apps/desktop/src-tauri/resources/extractors.json";

export function catalogue(): CatalogueEntry[] {
  return JSON.parse(readRepo(CATALOGUE_PATH)) as CatalogueEntry[];
}

/** The catalogue names an extractor; a model names its language by the profile's id. */
export const PROFILE_OF_EXTRACTOR: Readonly<Record<string, string>> = {
  java: "java",
  csharp: "csharp",
  typescript: "ts",
  elixir: "ex",
  ruby: "rb",
  python: "python",
};

const DISPLAY: Readonly<Record<string, string>> = {
  java: "Java",
  csharp: "C#",
  ts: "TypeScript",
  ex: "Elixir",
  rb: "Ruby",
  python: "Python",
};

/**
 * The extractors that merge a trace of the compiler or the runtime. Not data
 * anywhere in TypeScript — the flag is each extractor's own — so it is stated
 * here and the test holds it against the extractors' sources.
 */
export const TRACE_EXTRACTORS: readonly string[] = ["elixir", "ruby", "python"];

/** The language each framework profile describes. A profile's rows name modules, not a language. */
export const FRAMEWORK_LANGUAGE: Readonly<Record<string, string>> = {
  spring: "java",
};

/**
 * How the code a corpus references and does not declare is filed, READ FROM
 * THE REFERENCE FIXTURE of each extractor: the stub modules whose name is a
 * root in angle brackets, and whether there are named ones beside them. Step 2
 * reads the stack from these modules, and how fine that reading can be is a
 * property of the extractor nobody wrote down as data.
 */
export function outsideWorld(extractor: string): { readonly roots: readonly string[]; readonly named: boolean } {
  const model = readModelFileSync(join(REPO_ROOT, "fixtures", extractor, "expected", "model.jsonl"));
  const roots = new Set<string>();
  let named = false;
  for (const entity of model.entities) {
    if (!entity.traits.includes("TModule") || (entity as { isStub?: boolean }).isStub !== true) continue;
    const module = parseRenderedId(entity.id).module;
    const root = /^<[^>]+>/.exec(module)?.[0];
    if (root === undefined) named = true;
    else roots.add(root);
  }
  return { roots: [...roots].sort(), named };
}

const tick = (names: readonly string[]): string => (names.length === 0 ? "—" : names.map((name) => `\`${name}\``).join(", "));
const yesNo = (value: boolean): string => (value ? "yes" : "no");

function kindsWith(profile: Profile, trait: string, where: "required" | "either"): string[] {
  return Object.entries(profile.kinds)
    .filter(([, spec]) => {
      const required = (spec.required as readonly string[]).includes(trait);
      return where === "required" ? required : required || (spec.optional as readonly string[]).includes(trait);
    })
    .map(([kind]) => kind);
}

export function renderCapabilities(): string {
  const extractors = catalogue().filter((entry) => entry.role !== "pass");
  const pass = catalogue().find((entry) => entry.role === "pass");
  const langs = extractors.map((entry) => PROFILE_OF_EXTRACTOR[entry.name] ?? entry.name);
  const profiles = langs.map((lang) => {
    const profile = PROFILES[lang];
    if (profile === undefined) throw new Error(`no profile for '${lang}': complete PROFILE_OF_EXTRACTOR`);
    return profile;
  });

  const out: string[] = [];
  out.push("# What codegraph gives, per language");
  out.push("");
  out.push("GENERATED — do not edit. Rendered from the language profiles (`codegraph");
  out.push("profiles`), the framework profiles and the extractor catalogue, by");
  out.push("`CODEGRAPH_UPDATE_SNAPSHOTS=1 pnpm --filter @codegraph/cli test plugin-capabilities`.");
  out.push("");
  out.push("Read the column of the language at hand before a step, and say what is");
  out.push("missing BEFORE the person finds out. A language that is not in the first");
  out.push("table has no extractor: its files are counted at preflight, and nothing more");
  out.push("can be said about them.");
  out.push("");
  out.push("## Extractors");
  out.push("");
  out.push("| Language | `lang` | Files | Extractor | Install |");
  out.push("|---|---|---|---|---|");
  for (const [index, entry] of extractors.entries()) {
    const lang = langs[index]!;
    out.push(`| ${DISPLAY[lang] ?? lang} | \`${lang}\` | ${tick(entry.extensions)} | \`${entry.command}\` | \`${entry.install}\` |`);
  }
  out.push("");
  out.push("Every extractor takes the same flags: `--src DIR`, repeatable, and `--out FILE`.");
  out.push("It reads sources and runs nothing of the project.");
  if (pass !== undefined) {
    out.push("");
    out.push(`The metrics pass, \`${pass.command}\`, runs after any of them and adds measures to`);
    out.push(`the model it is given (\`${pass.install}\`).`);
  }
  out.push("");
  out.push("## What a model holds");
  out.push("");
  out.push(`| | ${langs.map((lang) => DISPLAY[lang] ?? lang).join(" | ")} |`);
  out.push(`|---|${langs.map(() => "---").join("|")}|`);
  const row = (label: string, value: (profile: Profile, index: number) => string): void => {
    out.push(`| ${label} | ${profiles.map(value).join(" | ")} |`);
  };
  row("A module is a", (profile) => tick(kindsWith(profile, "TModule", "required")));
  row("A type is a", (profile) => tick(kindsWith(profile, "TType", "required")));
  row("An operation is a", (profile) => tick(kindsWith(profile, "TInvocable", "required")));
  row("Kinds that may carry measures", (profile) => tick(kindsWith(profile, "TMetrics", "either")));
  row("Edge kinds", (profile) => tick(profile.edges));
  row("Annotations as edges (`annotationUse`)", (profile) => yesNo((profile.edges as readonly string[]).includes("annotationUse")));
  row("Inheritance as an edge", (profile) => yesNo((profile.edges as readonly string[]).includes("inheritance")));
  row("Takes a trace of the compiler or the runtime (`--trace`)", (_profile, index) => yesNo(TRACE_EXTRACTORS.includes(extractors[index]!.name)));
  row("External code is filed under", (profile, index) => {
    const outside = outsideWorld(extractors[index]!.name);
    const own = `one module per external ${kindsWith(profile, "TModule", "required").includes("package") ? "package" : kindsWith(profile, "TModule", "required").includes("namespace") ? "namespace" : "package or library"}`;
    return [...(outside.named ? [own] : []), ...outside.roots.map((root) => `\`${root}\``)].join(", ");
  });
  out.push("");
  out.push("How to read it:");
  out.push("");
  out.push("- **A module.** Where the module kind is `file` or `module`, a module is one");
  out.push("  source file: \"size per module\" is size per file, and the module graph is a");
  out.push("  graph of files. Where it is `package` or `namespace`, it groups files.");
  out.push("- **A type** is asked for by its trait, `TType`, never by a list of kinds: the");
  out.push("  shipped queries do, and so must any query you write.");
  out.push("- **Measures.** A kind that is not in the measures row has no size and no");
  out.push("  complexity. A query over measures skips it: absent is not zero.");
  out.push("- **No `annotationUse`:** no annotation census in step 2, and no entry point");
  out.push("  found by annotation in step 4.");
  out.push("- **External code.** Step 2 reads the technology stack from the modules the");
  out.push("  code references and does not declare. A name in angle brackets is a root that");
  out.push("  gathers many libraries. Where the row lists roots only, that table says how");
  out.push("  much the code leans on each side and no more: the bill of materials is then");
  out.push("  the build file, which you read and never run.");
  out.push("- **A trace** adds `generated` edges: what a macro, a `use` or a runtime hook");
  out.push("  wires. Without one those edges are not in the model. Producing a trace runs");
  out.push("  the project's own code: it is the person's to run, never yours.");
  out.push("");
  out.push("## Framework profiles");
  out.push("");
  out.push("| Framework | `--framework` | Language | Annotations | Roles it assigns |");
  out.push("|---|---|---|---|---|");
  for (const [id, profile] of Object.entries(FRAMEWORK_PROFILES)) {
    const lang = FRAMEWORK_LANGUAGE[id];
    if (lang === undefined) throw new Error(`no language for framework '${id}': complete FRAMEWORK_LANGUAGE`);
    const roles = [...new Set(profile.annotations.map((annotation) => annotation.role))];
    out.push(`| ${id[0]!.toUpperCase()}${id.slice(1)} | \`${id}\` | ${DISPLAY[lang] ?? lang} | ${profile.annotations.length} | ${tick(roles)} |`);
  }
  out.push("");
  out.push("No other framework has a profile. For any other, `analyze --report wiring` and");
  out.push("`--framework` have nothing to say; a step then says \"no profile for this");
  out.push("framework\", never \"there is none\".");
  out.push("");
  return out.join("\n");
}
