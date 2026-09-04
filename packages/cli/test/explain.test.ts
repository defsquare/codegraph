import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeInsights, type InsightRecord } from "@codegraph/insights";
import { fakeLlmClient, type LlmRequest, type Provider } from "@codegraph/llm";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { run } from "../src/main.js";
import { explainCommand, sidecarPathFor, type ExplainSeam } from "../src/commands/explain.js";
import { parseInvocation } from "../src/args.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));
const KEY = "sk-or-v1-test";

/** The fixture's source tree, loaded once into memory so the seam never touches disk during a run. */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(resolve(path), readFileSync(path, "utf8"));
    }
  };
  walk(SRC);
  return out;
}
const SOURCES = sourceFiles();

/** Answers a valid block from the request alone, like the insights run tests. */
function answer(request: LlmRequest): unknown {
  const unitId = /^# Unit: \w+ (\S+)/u.exec(request.user)?.[1] ?? "";
  const level = request.schema.name.replace(/^codegraph_/u, "").replace(/_cycle$/u, "");
  const block = (id: string): unknown => {
    const short = id.slice(id.lastIndexOf("/") + 1);
    if (level === "operation") {
      return { name: short, description: `Explains ${short}.`, safe: false, idempotent: null, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], confidence: 0.6 };
    }
    if (level === "type") {
      return { name: short, description: `Type ${short}.`, concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], confidence: 0.6 };
    }
    return { name: short, description: `Module ${short}.`, apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], confidence: 0.5 };
  };
  const cycle = /Return one entry per id: (.+)\./u.exec(request.user)?.[1];
  return cycle === undefined ? block(unitId) : { members: cycle.split(", ").map((id) => ({ id, block: block(id) })) };
}

function seamWith(env: Record<string, string | undefined>, files = new Map<string, string>()) {
  const client = fakeLlmClient({ respond: answer, usage: () => ({ promptTokens: 100, completionTokens: 20, cost: 0.0001 }) });
  const disk = new Map<string, string>([...SOURCES, ...files]);
  const providers: Provider[] = [];
  const seam: ExplainSeam = {
    env,
    fs: {
      exists: (path) => disk.has(resolve(path)),
      readFile: (path) => disk.get(resolve(path)),
      appendFile: (path, text) => void disk.set(resolve(path), (disk.get(resolve(path)) ?? "") + text),
      writeFileAtomic: (path, text) => void disk.set(resolve(path), text),
      remove: (path) => void disk.delete(resolve(path)),
    },
    clientFor: (provider) => {
      providers.push(provider);
      return client;
    },
    now: () => new Date("2026-09-02T10:00:00.000Z"),
  };
  return { seam, client, disk, providers };
}

const CF_ENV = { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc-1" };

function options(argv: readonly string[]) {
  const invocation = parseInvocation(["explain", FIXTURE, "--src", SRC, ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  return invocation.options;
}

const OUT = resolve("/virtual/model.insights.jsonl");

describe("explain --dry-run", () => {
  it("prints the plan on stdout, needs no key, and is byte-identical across runs", async () => {
    const a = captureIo();
    const b = captureIo();
    const codeA = await explainCommand(options(["--dry-run"]), a, seamWith({}).seam);
    const codeB = await explainCommand(options(["--dry-run"]), b, seamWith({}).seam);
    expect(codeA).toBe(EXIT.OK);
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stdout()).toContain("explain plan:");
    expect(a.stdout()).toMatch(/template\s+L0 operation java:com\.acme\.order\//u);
    expect(a.stdout()).toMatch(/llm\s+L\d+ type\s+java:com\.acme\.order\/Order/u);
    expect(a.stdout()).toMatch(/llm\s+L\d+ module\s+java:com\.acme\.order\b/u);
    expect(a.files().size).toBe(0);
    expect(codeB).toBe(EXIT.OK);
  });

  it("--json prints one machine-readable plan whose operations precede their type", async () => {
    const io = captureIo();
    await explainCommand(options(["--dry-run", "--json"]), io, seamWith({}).seam);
    const plan = JSON.parse(io.stdout()) as { kind: string; steps: { id: string; level: string; layer: number }[]; estimates: { calls: number } };
    expect(plan.kind).toBe("codegraph.explainPlan/1");
    expect(plan.estimates.calls).toBeGreaterThan(0);
    const order = plan.steps.find((s) => s.id === "java:com.acme.order/Order")!;
    for (const step of plan.steps.filter((s) => s.level === "operation" && s.id.startsWith("java:com.acme.order/Order."))) {
      expect(step.layer).toBeLessThan(order.layer);
    }
  });

  it("goes through run() as the one asynchronous command", async () => {
    const io = captureIo();
    const outcome = run(["explain", FIXTURE, "--src", SRC, "--dry-run", "--json"], io);
    expect(outcome).toBeInstanceOf(Promise);
    expect(await outcome).toBe(EXIT.OK);
    expect(io.stdout()).toContain("codegraph.explainPlan/1");
  });
});

describe("explain runs the walk against the model client", () => {
  it("writes header, sorted records and eof; templated accessors carry no model; the journal is gone", async () => {
    const { seam, client, disk } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("wrote ");
    const text = disk.get(OUT);
    expect(text).toBeDefined();
    const file = decodeInsights(text!);
    expect(file.header.kind).toBe("codegraph.insights/1");
    expect(file.header.metamodel).toBe("specy.domain/3");
    expect(file.truncated).toBe(false);
    expect(file.eof?.generatedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(file.eof?.counts.failed).toBe(0);
    expect(file.records.length).toBe(file.eof?.counts.records);
    const templated = file.records.filter((r) => r.origin === "template");
    expect(templated.length).toBeGreaterThan(0);
    for (const r of templated) expect(r.model).toBeUndefined();
    const explained = file.records.filter((r) => r.origin === "llm");
    // One call per unit, but a cycle call yields one record per member.
    expect(explained.length).toBeGreaterThanOrEqual(client.calls.length - countRepairs(client.calls));
    expect(countRepairs(client.calls)).toBe(0);
    for (const r of explained) expect(r.key?.lang).toBe("java");
    expect(disk.has(`${OUT}.journal`)).toBe(false);
    // Records sort operations → types → modules, by id.
    const levels = file.records.map((r) => r.level);
    expect(levels.indexOf("type")).toBeGreaterThan(levels.lastIndexOf("operation"));
    expect(levels.indexOf("module")).toBeGreaterThan(levels.lastIndexOf("type"));
  });

  it("a second run over the same side-car makes zero calls and leaves the body unchanged", async () => {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), first.seam);
    const before = first.disk.get(OUT)!;
    const second = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[OUT, before]]));
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, second.seam);
    expect(code).toBe(EXIT.OK);
    expect(second.client.calls).toHaveLength(0);
    const body = (text: string) => text.split("\n").slice(0, -2).join("\n");
    expect(body(second.disk.get(OUT)!)).toBe(body(before));
  });

  it("resumes from a journal left by an interrupted run", async () => {
    const first = seamWith({ OPENROUTER_API_KEY: KEY });
    await explainCommand(options(["--out", OUT]), captureIo(), first.seam);
    const records = decodeInsights(first.disk.get(OUT)!).records;
    // Pretend the run died after the operations: only their records are in the journal.
    const journal = records.filter((r: InsightRecord) => r.level === "operation").map((r) => `${JSON.stringify(r)}\n`).join("");
    const resumed = seamWith({ OPENROUTER_API_KEY: KEY }, new Map([[`${OUT}.journal`, journal]]));
    const io = captureIo();
    await explainCommand(options(["--out", OUT]), io, resumed.seam);
    expect(io.stderr()).toContain("resuming from");
    const levels = resumed.client.calls.map((c) => c.schema.name);
    expect(levels.every((n) => n !== "codegraph_operation" && n !== "codegraph_operation_cycle")).toBe(true);
    expect(levels.length).toBeGreaterThan(0);
  });

  it("--max-calls caps the calls and the rest is reported as skipped", async () => {
    const { seam, client } = seamWith({ OPENROUTER_API_KEY: KEY });
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT, "--max-calls", "3"]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(client.calls.length).toBeLessThanOrEqual(3);
    expect(io.stderr()).toMatch(/\d+ skipped/u);
  });
});

describe("explain --estimate", () => {
  it("reports input and output token volume per level on stdout, needs no key, and is byte-identical across runs", async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await explainCommand(options(["--estimate"]), a, seamWith({}).seam)).toBe(EXIT.OK);
    expect(await explainCommand(options(["--estimate"]), b, seamWith({}).seam)).toBe(EXIT.OK);
    expect(a.stdout()).toBe(b.stdout());
    const text = a.stdout();
    expect(text).toContain("explain estimate:");
    expect(text).toMatch(/units: 77 \(operation 57, type 17, module 3\) in \d+ layers/u);
    expect(text).toMatch(/calls: 68 \(template 9, reuse 0, skipped 0\)/u);
    expect(text).toMatch(/operation\s+48\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/type\s+17\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/module\s+3\s+[\d ]+\s+[\d ]+/u);
    expect(text).toMatch(/total\s+68\s+[\d ]+\s+[\d ]+/u);
    expect(text).toContain("cost: pass --price-in USD --price-out USD");
    expect(a.files().size).toBe(0);
  });

  it("prices the volume when both prices are given, in text and JSON", async () => {
    const io = captureIo();
    await explainCommand(options(["--estimate", "--price-in", "0.10", "--price-out", "0.60"]), io, seamWith({}).seam);
    expect(io.stdout()).toMatch(/cost at \$0\.1\/M in, \$0\.6\/M out: \$\d+\.\d{4}/u);
    const json = captureIo();
    await explainCommand(options(["--estimate", "--json", "--price-in", "0.10", "--price-out", "0.60"]), json, seamWith({}).seam);
    const report = JSON.parse(json.stdout()) as { kind: string; calls: number; promptTokens: number; completionTokens: number; cost: number; byLevel: Record<string, { completionTokens: number }> };
    expect(report.kind).toBe("codegraph.explainEstimate/1");
    expect(report.calls).toBe(68);
    // Output = one measured block average per block asked for: a cycle call asks for several.
    const per = { operation: 450, type: 650, module: 900 } as const;
    const calls = { operation: 48, type: 17, module: 3 } as const;
    let sum = 0;
    for (const level of ["operation", "type", "module"] as const) {
      const tokens = report.byLevel[level]?.completionTokens ?? 0;
      expect(tokens % per[level]).toBe(0);
      expect(tokens).toBeGreaterThanOrEqual(calls[level] * per[level]);
      sum += tokens;
    }
    expect(report.completionTokens).toBe(sum);
    expect(report.promptTokens).toBeGreaterThan(report.completionTokens);
    expect(report.cost).toBeCloseTo((report.promptTokens * 0.1 + report.completionTokens * 0.6) / 1_000_000, 10);
  });

  it("goes through run() and rejects a malformed price at parse time", async () => {
    const io = captureIo();
    expect(await run(["explain", FIXTURE, "--src", SRC, "--estimate", "--json"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("codegraph.explainEstimate/1");
    expect(() => parseInvocation(["explain", FIXTURE, "--estimate", "--price-in", "cheap"])).toThrow(/--price-in must be a non-negative USD amount/u);
    expect(() => parseInvocation(["explain", FIXTURE, "--estimate", "--price-out=-1"])).toThrow(/--price-out must be/u);
  });
});

describe("explain picks its provider from the flag or the environment", () => {
  it("auto routes through Cloudflare AI Gateway when only its variables are set, and records it in the header", async () => {
    const { seam, providers, disk } = seamWith(CF_ENV);
    const io = captureIo();
    const code = await explainCommand(options(["--out", OUT]), io, seam);
    expect(code).toBe(EXIT.OK);
    expect(new Set(providers)).toEqual(new Set(["cloudflare"]));
    expect(io.stderr()).toContain("provider: fake (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set)");
    expect(decodeInsights(disk.get(OUT)!).header.provider).toBe("cloudflare");
  });

  it("auto keeps OpenRouter when both are configured; --provider cloudflare overrides", async () => {
    const both = { OPENROUTER_API_KEY: KEY, ...CF_ENV };
    const a = seamWith(both);
    await explainCommand(options(["--out", OUT]), captureIo(), a.seam);
    expect(new Set(a.providers)).toEqual(new Set(["openrouter"]));
    const b = seamWith(both);
    const io = captureIo();
    await explainCommand(options(["--out", OUT, "--provider", "cloudflare"]), io, b.seam);
    expect(new Set(b.providers)).toEqual(new Set(["cloudflare"]));
    expect(io.stderr()).toContain("--provider cloudflare");
  });

  it("--provider cloudflare without its variables is a usage error naming them", async () => {
    const io = captureIo();
    await expect(explainCommand(options(["--out", OUT, "--provider", "cloudflare"]), io, seamWith({ OPENROUTER_API_KEY: KEY }).seam)).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set/u,
    );
    expect(io.stdout()).toBe("");
  });

  it("rejects an unknown provider at parse time", () => {
    expect(() => parseInvocation(["explain", FIXTURE, "--provider", "azure"])).toThrow(/invalid value 'azure' for --provider/u);
    expect(options([]).provider).toBe("auto");
  });
});

describe("explain usage errors exit 2 with nothing on stdout", () => {
  it("without an API key when calls are planned", async () => {
    const io = captureIo();
    const code = await run(["explain", FIXTURE, "--src", SRC, "--out", OUT], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("OPENROUTER_API_KEY");
    expect(io.stderr()).toContain("CLOUDFLARE_API_TOKEN");
  }, 20_000);

  it("with --src and two models", () => {
    expect(() => parseInvocation(["explain", FIXTURE, FIXTURE, "--src", SRC])).toThrow(/--src applies to one model/u);
  });

  it("with a source root that does not hold the anchored files", async () => {
    const io = captureIo();
    const code = await explainCommand(options(["--dry-run"]), io, seamWith({}, new Map()).seam);
    expect(code).toBe(EXIT.OK); // the fixture sources are on the fake disk
    const wrong = captureIo();
    const invocation = parseInvocation(["explain", FIXTURE, "--src", "/nowhere", "--dry-run"]);
    if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("unreachable");
    await expect(explainCommand(invocation.options, wrong, seamWith({}).seam)).rejects.toThrow(/does not contain/u);
  });

  it("with a --scope id the model does not declare", async () => {
    const io = captureIo();
    await expect(explainCommand(options(["--dry-run", "--scope", "java:nope/Nothing"]), io, seamWith({}).seam)).rejects.toThrow(/--scope names an id/u);
  });
});

describe("sidecarPathFor", () => {
  it("replaces .jsonl and appends otherwise", () => {
    expect(sidecarPathFor("out/model.jsonl")).toBe("out/model.insights.jsonl");
    expect(sidecarPathFor("model.db")).toBe("model.db.insights.jsonl");
  });
});

describe("the CLI stays off the provider SDK", () => {
  it("imports @codegraph/llm, never the SDK", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".ts")) files.push(path);
      }
    };
    walk(src);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("@openrouter" + "/sdk")).map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });
});

function countRepairs(calls: readonly LlmRequest[]): number {
  return calls.filter((c) => c.user.includes("## Your previous answer was not valid")).length;
}
