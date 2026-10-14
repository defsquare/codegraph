// Renders content/docs/reference/profiles.md from `codegraph profiles --lang <lang>`, one
// section per profile core ships, so the page never drifts from the CLI:
//   node website/scripts/profiles-page.mjs > website/content/docs/reference/profiles.md
// Needs the CLI built (pnpm -r build); runs bin/codegraph from the repository root.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codegraph = (...args) => execFileSync(join(root, "bin", "codegraph"), args, { encoding: "utf8" });

const NAMES = { clj: "Clojure", csharp: "C#", ex: "Elixir", go: "Go", java: "Java", js: "JavaScript", php: "PHP", python: "Python", rb: "Ruby", rust: "Rust", ts: "TypeScript" };
const EXTRACTORS = [["java", "Java"], ["csharp", "C#"], ["ts", "TypeScript"], ["ex", "Elixir"], ["rb", "Ruby"]];
const PAGE = { java: "java-extractor", csharp: "csharp-extractor", ts: "typescript-extractor", ex: "elixir-extractor", rb: "ruby-extractor" };
// A code span whose text holds a backtick needs a double-backtick fence.
const FENCED = ["Repository`1", "System.Func`2<!!0,System.String>"];

const langs = codegraph("profiles").split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter((l) => l in NAMES);

function parse(text) {
  const lines = text.split("\n");
  const summary = /summary: (\d+) kinds, (\d+) edge kinds, (\d+) notes/.exec(lines.find((l) => l.startsWith("summary:")));
  const edges = lines.find((l) => l.startsWith("edge kinds:")).slice("edge kinds:".length).split(",").map((s) => s.trim());
  const kinds = [];
  for (let i = lines.indexOf("kinds:") + 1; i < lines.length && !lines[i].startsWith("notes:"); i++) {
    const kind = /^  (\S+)$/.exec(lines[i]);
    if (kind) { kinds.push({ name: kind[1], required: [], optional: [] }); continue; }
    const traits = /^    (required|optional)\s+(.*)$/.exec(lines[i]);
    if (traits) kinds.at(-1)[traits[1]] = traits[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const notes = [];
  for (let n = lines.indexOf("notes:") + 1; n < lines.length; n++) {
    const l = lines[n];
    if (l.startsWith("  - ")) notes.push(l.slice(4));
    else if (l.trim() !== "" && notes.length) notes[notes.length - 1] += "\n" + l;
  }
  return { counts: summary.slice(1).map(Number), edges, kinds, notes: notes.map((note) => FENCED.reduce((s, f) => s.replaceAll("`" + f + "`", "``" + f + "``"), note)) };
}

const profiles = Object.fromEntries(langs.map((lang) => [lang, parse(codegraph("profiles", "--lang", lang))]));
const tick = (xs) => xs.map((x) => "`" + x + "`").join(", ");
const out = [];
out.push(`---
title: Language profiles
linkTitle: Language profiles
weight: 4
---

The profiles \`@codegraph/core\` ships: per entity kind, the traits an extractor must emit and the traits it may emit, plus the edge kinds the language can produce and the profile's documented blind spots.

{{< callout type="info" >}}
Generated content. Every table on this page is a rendering of \`codegraph profiles --json\`; run it for the machine-readable form.

\`\`\`bash
codegraph profiles --json          # all eleven profiles
codegraph profiles --lang java     # one profile, as text
\`\`\`
{{< /callout >}}

A profile licenses an entity by the rule \`required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)\`. What a profile *is* — and why it is data rather than code — is on [Profiles](/docs/reference/metamodel/profiles/).

## Summary

| \`lang\` | Language | Kinds | Edge kinds | Notes |
|---|---|---|---|---|`);
for (const lang of langs) {
  const [k, e, n] = profiles[lang].counts;
  out.push(`| \`${lang}\` | ${NAMES[lang]} | ${k} | ${e} | ${n} |`);
}
const shipped = EXTRACTORS.map(([l]) => "`" + l + "`");
const pages = EXTRACTORS.map(([l, name]) => `[${name}](/docs/reference/${PAGE[l]}/)`);
out.push(`
A profile that is specified but has no shipped extractor is complete, not deficient: the profile is the contract an extractor is written against. Today ${shipped.slice(0, -1).join(", ")} and ${shipped.at(-1)} have one: see the ${pages.slice(0, -1).join(", ")} and ${pages.at(-1)} extractor pages. Every shipped extractor's model can then be measured by the [metrics pass](/docs/reference/metrics-pass/).`);
for (const lang of langs) {
  const p = profiles[lang];
  out.push("", `## ${NAMES[lang]} — \`${lang}\``, "");
  if (lang === "ts") out.push("Declaration spaces: `abstractClass`, `arrowFunction`, `class`, `enum`, `function`, `interface`, `method`, `module`, `namespace`, `parameter`, `property`, `typeAlias`, `variable`.", "");
  out.push("**Edge kinds:** " + p.edges.map((e) => "`" + e + "`").join(" · "), "");
  out.push("| Kind | Required traits | Optional traits |", "|---|---|---|");
  for (const k of p.kinds) out.push(`| \`${k.name}\` | ${tick(k.required)} | ${tick(k.optional)} |`);
  out.push("", "**Notes**", "");
  for (const note of p.notes) out.push("- " + note);
}
process.stdout.write(out.join("\n") + "\n");
