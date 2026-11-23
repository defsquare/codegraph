import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDomainFacts } from "@codegraph/analyzer";
import {
  EXPLAIN_WALK,
  buildWalk,
  collectUnits,
  contextPackFor,
  createSourceReader,
  customizeExplain,
  memoryBook,
  planRun,
  stampedBeforeSplit,
  type ContextEnv,
  type EntityEnv,
  type PlanEnv,
  type PlanOptions,
  type WalkSpec,
} from "@codegraph/insights";
import { promptOverhead } from "@codegraph/llm";
import { buildVocabulary, definitionSpeller, rankedWords, type VocabularyArtifact } from "@codegraph/vocabulary";
import { parseInvocation } from "../src/args.js";
import { captureIo } from "../src/io.js";
import { openAnalysis } from "../src/source.js";
import { resolveView } from "../src/view.js";

/**
 * EXPLAIN CUSTOMIZED WITH NOTHING TO CARRY, ON THE GOLDENS' OWN INPUTS (PLAN.md
 * §22.6 step 5). `customizeExplain` given nothing, or entity instructions that
 * select nothing, must hash every unit of the Java fixture exactly as the
 * committed `golden/explain/java/units.txt` says — fingerprint, chain and
 * pre-split stamp — wired as explain-golden.test.ts wires the engine (the
 * vocabulary's speller, explain's view, its defaults). A customization that
 * selects something must not, or the comparison would prove nothing.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./golden/explain/java/", import.meta.url));
const MODEL = "fixtures/java/expected/model.jsonl";

let cwd = "";
beforeAll(() => {
  cwd = process.cwd();
  // The model's root (`fixtures/java/src`) is relative to the repo, as the goldens read it.
  process.chdir(REPO);
});
afterAll(() => process.chdir(cwd));

/** `units.txt` for a spec, line for line as the golden suite writes it. */
function unitsText(customize: (env: EntityEnv) => WalkSpec): string {
  const invocation = parseInvocation(["explain", MODEL, "--no-cache"]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  const options = invocation.options;
  const models = (JSON.parse(readFileSync(join(GOLDEN, "plan.jsonl"), "utf8").split("\n")[0] ?? "{}") as { models: PlanOptions["models"] }).models;
  const source = openAnalysis(options.models, options, captureIo());
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const facts = buildDomainFacts(graph, { view });
    const units = collectUnits(graph, facts);
    const walk = buildWalk(units, graph, view);
    const root = resolve(graph.union.models[0]?.root ?? ".");
    const reader = createSourceReader((relative) => {
      try {
        return readFileSync(join(root, relative), "utf8");
      } catch {
        return undefined;
      }
    });
    let vocabulary: VocabularyArtifact | undefined;
    const speller = { words: definitionSpeller(graph), ranked: (id: string) => rankedWords((vocabulary ??= buildVocabulary(graph, { view })), id) };
    const spec = customize({ graph, view, units, walk });
    const env: PlanEnv = { graph, facts, units, reader, unitOf: walk.unitOf, speller, spec };
    const planOptions: PlanOptions = {
      models,
      depth: options.depth,
      maxLines: options.maxLines,
      maxScc: options.maxScc,
      force: options.force,
      maxCalls: options.maxCalls,
      inScope: undefined,
      terms: options.terms,
      promptOverhead: promptOverhead("openrouter"),
    };
    const plan = planRun(walk, new Map(), env, planOptions);
    const contextEnv: ContextEnv = { ...env, records: memoryBook([], spec), depth: options.depth, maxLines: options.maxLines, terms: options.terms };
    const stamped = new Map<string, string>();
    const lines = plan.steps.map((step) => {
      const { unit } = step;
      const pack = contextPackFor(unit, contextEnv);
      stamped.set(unit.id, unit.deps.length === 0 ? step.fingerprint : stampedBeforeSplit(pack, step.model, options.depth, unit.deps.map((dep) => stamped.get(dep) ?? ""), []));
      const hashes = plan.hashes.get(unit.id);
      const template = step.template === undefined ? "" : ` (${step.template})`;
      const members = unit.members.length > 1 ? ` [${unit.members.length} members]` : "";
      const stamp = stamped.get(unit.id) ?? "?";
      return `${unit.level} ${unit.id}${members} ${step.status}${template} fingerprint=${hashes?.fingerprint} chain=${hashes?.chain}${stamp === hashes?.fingerprint ? "" : ` stamped=${stamp}`}`;
    });
    return `${lines.join("\n")}\n`;
  } finally {
    source.close();
  }
}

describe("explain customized with nothing to carry hashes as the committed goldens", () => {
  const golden = (): string => readFileSync(join(GOLDEN, "units.txt"), "utf8");

  it("nothing given", { timeout: 120_000 }, () => {
    expect(unitsText((env) => customizeExplain(EXPLAIN_WALK, {}, env))).toBe(golden());
  });

  it("entity instructions that select nothing", { timeout: 120_000 }, () => {
    const spec = (env: EntityEnv) => customizeExplain(EXPLAIN_WALK, { entities: [{ select: { type: "id", id: "java:nowhere/Nothing" }, instructions: "Never shown." }] }, env);
    expect(unitsText(spec)).toBe(golden());
  });

  it("and the comparison bites: an instruction that selects Basket does not", { timeout: 120_000 }, () => {
    const spec = (env: EntityEnv) => customizeExplain(EXPLAIN_WALK, { entities: [{ select: { type: "id", id: "java:com.acme.order/Basket" }, instructions: "Basket is the cart." }] }, env);
    expect(unitsText(spec)).not.toBe(golden());
  });
});
