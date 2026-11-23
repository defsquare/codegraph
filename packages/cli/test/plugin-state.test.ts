import { describe, expect, it } from "vitest";
import { pluginFiles, readDoc, readPlugin, schemaViolations, skills, uncheckedKeywords } from "./plugin-support.js";

/**
 * THE STATE IS WHAT THE PAGES ASK FOR (PLAN.md §24.3, §24.8).
 *
 * `.codegraph/discovery.json` is how one session hands the walk to the next,
 * and how another tool (Specy, at step 6) learns what was found. Its schema is
 * `plugin/references/discovery.schema.json`, hand-written so an agent can read
 * it. Three things can go wrong silently and are held here:
 *
 *  - the examples an agent copies from stop being valid;
 *  - a step's `findings` drift from its page's "Write down" list — the list
 *    is the page's, so each finding names the item it answers, and the two
 *    sets must be equal;
 *  - a field appears that the principles forbid: a price (a price is read
 *    from a run's own estimate, never from a file).
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [keyword: string]: Json };

const schema = JSON.parse(readPlugin("references/discovery.schema.json")) as Schema;
const EXAMPLES = pluginFiles("references/examples").filter((path) => path.endsWith(".discovery.json"));
const example = (path: string): { [key: string]: Json } => JSON.parse(readPlugin(path)) as { [key: string]: Json };

/** The page of each step, and the key its findings live under. */
const STEP_PAGES: Readonly<Record<string, string>> = {
  structure: "discover/structure.md",
  boundaries: "discover/boundaries.md",
  activity: "discover/activity.md",
  stimuli: "discover/stimuli.md",
  meaning: "discover/meaning.md",
  domain: "discover/domain.md",
};

/** The step keys whose skill this version of the plugin ships: `discover-<n>-<key>`. */
const SHIPPED_STEPS = skills()
  .map((skill) => /^discover-\d-(.+)$/.exec(skill.name)?.[1])
  .filter((key): key is string => key !== undefined);

/** The bullets of a page's "## Write down" section, each as one line of text. */
function writeDown(page: string): string[] {
  const markdown = readDoc(page);
  const start = markdown.indexOf("\n## Write down\n");
  if (start === -1) throw new Error(`${page} has no "Write down" section`);
  const section = markdown.slice(start + 1).split("\n").slice(1);
  const end = section.findIndex((line) => line.startsWith("## ") || /^Next: /.test(line));
  const items: string[] = [];
  for (const line of section.slice(0, end === -1 ? section.length : end)) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (line.startsWith("  ") && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** The schema of each step's entry, by step key. */
const STEPS = ((schema["properties"] as Schema)["steps"] as Schema)["properties"] as { [key: string]: Schema };

describe("the schema is one this file can check", () => {
  it("uses only keywords the checker implements", () => {
    expect(uncheckedKeywords(schema)).toEqual([]);
  });

  it("names its own kind and version", () => {
    expect(schema["title"]).toBe("codegraph.discovery/1");
    expect(((schema["properties"] as Schema)["kind"] as Schema)["const"]).toBe("codegraph.discovery/1");
  });

  it("has a key for each of the six steps, in the pages' own names", () => {
    expect(Object.keys(STEPS)).toEqual(Object.keys(STEP_PAGES));
  });

  it("has no place for a price", () => {
    const names: string[] = [];
    const walk = (node: Json): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const [key, value] of Object.entries(node)) {
        if (key === "properties") names.push(...Object.keys(value as Schema));
        walk(value);
      }
    };
    walk(schema);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => /price|cost/i.test(name))).toEqual([]);
    expect(names).toContain("ceilingUsd"); // a ceiling the person sets, and
    expect(names).toContain("usd"); //          what a run reported: neither is a price
  });
});

describe("the example states are valid", () => {
  it("ships a state that has just started, one after step 1 and one after a tour", () => {
    expect(EXAMPLES).toEqual([
      "references/examples/after-step-1.discovery.json",
      "references/examples/after-the-tour.discovery.json",
      "references/examples/cold.discovery.json",
    ]);
  });

  it.each(EXAMPLES)("%s conforms to the schema", (path) => {
    expect(schemaViolations(schema, example(path))).toEqual([]);
  });

  it("refuses what the schema is there to refuse", () => {
    const base = example("references/examples/after-step-1.discovery.json");
    const broken = (change: (state: { [key: string]: Json }) => void): string[] => {
      const copy = structuredClone(base);
      change(copy);
      return schemaViolations(schema, copy);
    };
    const structure = (state: { [key: string]: Json }): { [key: string]: Json } =>
      (state["steps"] as { [key: string]: Json })["structure"] as { [key: string]: Json };
    const firstFinding = (state: { [key: string]: Json }, key: string): { [key: string]: Json } =>
      ((structure(state)["findings"] as { [key: string]: Json })[key] as Json[])[0] as { [key: string]: Json };

    expect(broken((state) => (state["price"] = 0.1)).join()).toContain("unknown field price");
    expect(broken((state) => (structure(state)["status"] = "finished")).join()).toContain("not one of");
    expect(broken((state) => delete firstFinding(state, "stubs")["anchor"]).join()).toContain("missing anchor");
    expect(broken((state) => (firstFinding(state, "stubs")["kind"] = "certain")).join()).toContain("not one of");
    expect(broken((state) => (firstFinding(state, "stubs")["anchor"] = { file: "A.java" })).join()).toContain("alternatives");
    expect(broken((state) => ((structure(state)["findings"] as { [key: string]: Json })["hotspots"] = [])).join()).toContain("unknown field hotspots");
  });

  it("anchors every finding, with a kind, and dates every finished step at a commit", () => {
    for (const path of EXAMPLES) {
      const steps = example(path)["steps"] as { [key: string]: { [key: string]: Json } };
      for (const [key, step] of Object.entries(steps)) {
        if (step["status"] === "done" || step["status"] === "partial") {
          expect(typeof step["commit"], `${path}: steps.${key}.commit`).toBe("string");
          expect(typeof step["at"], `${path}: steps.${key}.at`).toBe("string");
        }
      }
    }
    const after = example("references/examples/after-step-1.discovery.json");
    const findings = ((after["steps"] as { [key: string]: Json })["structure"] as { [key: string]: Json })["findings"] as { [key: string]: Json[] };
    const roots = new Set(((after["corpus"] as { [key: string]: Json })["roots"] as { name: string }[]).map((root) => root.name));
    for (const [key, list] of Object.entries(findings)) {
      expect(list.length, key).toBeGreaterThan(0);
      for (const finding of list as { root?: string }[]) expect(roots.has(finding.root ?? ""), `${key}: root`).toBe(true);
    }
  });
});

describe("the state after a tour", () => {
  const tour = example("references/examples/after-the-tour.discovery.json");
  const steps = tour["steps"] as { [key: string]: { status: string; findings: { [key: string]: { kind: string; anchor: { [key: string]: Json }; root?: string }[] } } };

  it("is three steps done, no question answered, nothing spent", () => {
    expect((tour["intake"] as { [key: string]: Json })["time"]).toBe("tour");
    expect(Object.keys(steps)).toEqual(["structure", "boundaries", "activity"]);
    for (const step of Object.values(steps)) expect(step.status).toBe("done");
    expect(tour["spend"]).toEqual([]);
    const questions = tour["questions"] as { status: string; step: string }[];
    expect(questions.length).toBeGreaterThan(4);
    expect(questions.every((question) => question.status === "open")).toBe(true);
    expect(new Set(questions.map((question) => question.step))).toEqual(new Set(["structure", "boundaries", "activity"]));
  });

  it("marks every root nobody confirmed as a guess", () => {
    const roots = (tour["corpus"] as { roots: { guessed?: boolean }[] }).roots;
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((root) => root.guessed === true)).toBe(true);
  });

  it("writes every finding of every step, each anchored to a file of the workspace", () => {
    for (const [key, step] of Object.entries(steps)) {
      const expected = Object.keys(((STEPS[key]!["properties"] as Schema)["findings"] as Schema)["properties"] as Schema);
      expect(Object.keys(step.findings).sort(), key).toEqual([...expected].sort());
      for (const list of Object.values(step.findings)) {
        expect(list.length).toBeGreaterThan(0);
        for (const finding of list) expect(typeof finding.anchor["artifact"], key).toBe("string");
      }
    }
  });

  it("holds what the commits did as co-change, never as a declared fact", () => {
    for (const list of Object.values(steps["activity"]!.findings)) for (const finding of list) expect(finding.kind).toBe("co-change");
  });

  it("names nobody: a share, a count and a date", () => {
    for (const path of EXAMPLES) {
      const text = readPlugin(path);
      expect(text, `${path}: an address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
      expect(text, `${path}: an author line`).not.toMatch(/"(author|owner|name)":\s*"[A-Z][a-z]+ [A-Z][a-z]+/);
    }
    const owners = steps["activity"]!.findings["owners"]![0] as unknown as { value: { [key: string]: Json }[] };
    for (const owner of owners.value) expect(Object.keys(owner).sort()).toEqual(["authors", "file", "ownerLastSeen", "ownerRank", "ownerShare"]);
  });
});

describe("a step's findings are its page's \"Write down\" list", () => {
  it("ships the first four steps", () => {
    expect(SHIPPED_STEPS).toEqual(["structure", "boundaries", "activity", "stimuli"]);
  });

  it.each(SHIPPED_STEPS)("%s: every finding answers an item of the page, and every item has a finding", (key) => {
    const properties = (STEPS[key]!["properties"] as Schema)["findings"] as Schema;
    const findings = properties["properties"] as { [name: string]: Schema };
    const items = writeDown(STEP_PAGES[key]!);
    expect(items.length, `${STEP_PAGES[key]} lists nothing to write down`).toBeGreaterThan(1);

    const answered = new Set<string>();
    for (const [name, finding] of Object.entries(findings)) {
      const item = finding["x-page-item"];
      expect(items, `${key}.findings.${name} names an item the page does not list: ${String(item)}`).toContain(item);
      answered.add(item as string);
    }
    expect(items.filter((item) => !answered.has(item)), "an item of the page with no finding").toEqual([]);
    expect((properties["additionalProperties"] as Json) === false, "a shipped step's findings are a closed list").toBe(true);
  });

  it.each(SHIPPED_STEPS)("%s: the skill's own table writes exactly those keys", (key) => {
    const skill = skills().find((candidate) => candidate.name.endsWith(`-${key}`))!;
    const properties = (STEPS[key]!["properties"] as Schema)["findings"] as Schema;
    const expected = Object.keys(properties["properties"] as Schema).sort();
    const write = skill.body.slice(skill.body.indexOf("\n## Write\n"), skill.body.indexOf("\n## Gate\n"));
    const written = [...write.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((match) => match[1]!).sort();
    expect(written).toEqual(expected);
  });
});

describe("the words the walk teaches are the page's", () => {
  it("references/words.md holds the page's list, with its links made absolute", () => {
    const page = readDoc("discover/_index.md");
    const start = page.indexOf("## Words used in this section");
    const list = page
      .slice(start, page.indexOf("\n## ", start + 5))
      .split("\n")
      .slice(1)
      .join("\n")
      .trim()
      .replaceAll("](/docs/", "](https://codegraph.biz/docs/");
    expect(list.split("\n- ").length).toBeGreaterThan(10);
    expect(readPlugin("references/words.md").trimEnd().endsWith(list)).toBe(true);
  });
});
