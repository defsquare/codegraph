import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeModelToString, readModelFileSync, type Model } from "@codegraph/core";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph validate` is the acceptance gate an extractor author points at
 * their own output, so these tests judge it the way that author would: does it
 * pass real Spoon output, and when it fails, does the report NAME the entity
 * and the rule without anyone opening a debugger?
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "codegraph-validate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(): Model {
  return readModelFileSync(FIXTURE);
}

/**
 * A copy of the Spoon snapshot on disk with exactly one invariant broken,
 * written through core's own encoder — so the file stays a real model file and
 * the finding is about its CONTENT, not about its bytes.
 */
function corrupted(name: string, mutate: (model: Model) => void): string {
  const model = fixture();
  mutate(model);
  const path = join(scratch, name);
  writeFileSync(path, encodeModelToString(model), "utf8");
  return path;
}

/** Rewrites one record by hand, for corruptions no encoder would produce. */
function corruptedRecord(
  name: string,
  tag: string,
  edit: (record: Record<string, unknown>) => void,
  pick: (record: Record<string, unknown>) => boolean = () => true,
): string {
  const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((line) => line !== "");
  const at = lines.findIndex(
    (line) => line.startsWith(`{"t":"${tag}"`) && pick(JSON.parse(line) as Record<string, unknown>),
  );
  const record = JSON.parse(lines[at]!) as Record<string, unknown>;
  edit(record);
  const path = join(scratch, name);
  writeFileSync(path, `${[...lines.slice(0, at), JSON.stringify(record), ...lines.slice(at + 1)].join("\n")}\n`, "utf8");
  return path;
}

function firstEdge(): { from: string; to: string } {
  const edge = fixture().edges[0];
  if (edge === undefined) throw new Error("the fixture has no edges");
  return { from: edge.from, to: edge.to };
}

function firstClassId(): string {
  const entity = fixture().entities.find(
    (candidate) => candidate.kind === "class" && (candidate as { isStub?: boolean }).isStub !== true,
  );
  if (entity === undefined) throw new Error("the fixture has no corpus-declared class");
  return entity.id;
}

function invoke(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const io = captureIo();
  const code = run(argv, io);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

describe("codegraph validate on clean output", () => {
  it("exits 0 with a clean verdict on the committed Spoon snapshot", () => {
    const result = invoke(["validate", FIXTURE]);

    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("OK — every model conforms");
    expect(result.stdout).toContain("169 entities");
    expect(result.stdout).toContain("179 edges");
    expect(result.stdout).not.toContain("FAILED");
  });

  it("puts the report on stdout and leaves stderr empty (decision 3)", () => {
    const result = invoke(["validate", FIXTURE]);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("--json prints one parseable object and nothing else (decision 8)", () => {
    const result = invoke(["validate", FIXTURE, "--json"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      findings: unknown[];
      counts: { errors: number };
      subject: { entities: number; stubs: number; edges: number };
    };
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.counts.errors).toBe(0);
    expect(report.subject).toMatchObject({ entities: 169, stubs: 26, edges: 179 });
  });

  it("is deterministic — the same invocation twice is byte-identical (decision 6)", () => {
    expect(invoke(["validate", FIXTURE]).stdout).toBe(invoke(["validate", FIXTURE]).stdout);
  });

  it("uses no ANSI escape codes (decision 4)", () => {
    // The escape is written as a sequence, never pasted: a raw ESC byte would
    // make git call this file binary.
    expect(invoke(["validate", FIXTURE]).stdout).not.toContain(String.fromCharCode(27));
  });
});

describe("codegraph validate names what is wrong", () => {
  const cases: readonly {
    readonly what: string;
    readonly file: string;
    readonly code: string;
    readonly names: string;
  }[] = [
    {
      what: "a self-edge",
      file: corrupted("self-edge.jsonl", (model) => {
        const edge = model.edges[0];
        if (edge !== undefined) edge.to = edge.from;
      }),
      code: "self-reference/self-edge",
      names: firstEdge().from,
    },
    {
      what: "an empty candidates array",
      file: corrupted("empty-candidates.jsonl", (model) => {
        const edge = model.edges[0];
        if (edge !== undefined) edge.candidates = [];
      }),
      code: "candidates/candidates-empty",
      names: firstEdge().from,
    },
    {
      what: "an entity missing a required trait",
      file: corrupted("missing-trait.jsonl", (model) => {
        const entity = model.entities.find(
          (candidate) => candidate.kind === "class" && (candidate as { isStub?: boolean }).isStub !== true,
        );
        if (entity !== undefined) {
          entity.traits = entity.traits.filter((trait) => trait !== "TWithInheritances");
        }
      }),
      code: "profile/missing-required-trait",
      names: firstClassId(),
    },
  ];

  it.each(cases)("exits 3 on $what and names the offender", ({ file, code, names }) => {
    const result = invoke(["validate", file]);

    // FINDINGS, never INTERNAL: the tool worked, the model did not (decision 2).
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.code).not.toBe(EXIT.INTERNAL);
    expect(result.stdout).toContain(code);
    expect(result.stdout).toContain(names);
    expect(result.stdout).toContain("FAILED");
    expect(result.stderr).toBe("");
  });

  it.each(cases)("reports $what identically under --json", ({ file, code, names }) => {
    const result = invoke(["validate", file, "--json"]);
    expect(result.code).toBe(EXIT.FINDINGS);

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      findings: readonly { code: string; message: string; path: string }[];
      counts: { byCode: Record<string, number> };
    };
    const bare = code.split("/")[1] ?? code;
    expect(report.ok).toBe(false);
    expect(report.counts.byCode[bare]).toBe(1);
    expect(report.findings.some((finding) => finding.message.includes(names))).toBe(true);
  });

  it("prints the rule and the location on one line, the sentence on the next", () => {
    const self = cases.find((c) => c.code.includes("self-edge"));
    const file = self?.file ?? "";
    const lines = invoke(["validate", file]).stdout.split("\n");
    const header = lines.findIndex((line) => line.includes("self-reference/self-edge"));

    expect(header).toBeGreaterThan(-1);
    expect(lines[header]).toContain("error");
    expect(lines[header]).toContain(file);
    expect(lines[header]).toContain("edges[");
    expect(lines[header + 1]).toContain(self?.names ?? "");
  });

  it("counts findings by code before listing them", () => {
    const file = cases.find((c) => c.code.includes("candidates-empty"))?.file ?? "";
    const stdout = invoke(["validate", file]).stdout;
    expect(stdout).toContain("findings by code:");
    expect(stdout).toMatch(/\n\s+1\s+candidates-empty\n/);
  });
});

describe("codegraph validate keeps the failure classes apart (decision 2)", () => {
  it("exits 3 on a file that is not a model at all, and still names it", () => {
    const path = join(scratch, "not-a-model.jsonl");
    writeFileSync(path, "{ this is not json", "utf8");
    const result = invoke(["validate", path]);

    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stdout).toContain("unreadable as a model");
    expect(result.stdout).toContain(path);
  });

  // Regression: the text form used to print Zod's FIRST line only, which is the
  // boilerplate "invalid model.jsonl:" — a failure reported without its reason,
  // and strictly less than `--json` held, against decision 8.
  it("says WHICH key is wrong, not just that the file is unreadable", () => {
    // A 0 start line: spans are 1-based, so this record cannot be read at all.
    const path = corruptedRecord(
      "span-zero.jsonl",
      "e",
      (record) => {
        const anchor = record["anchor"] as [number, number, number];
        record["anchor"] = [anchor[0], 0, anchor[2]];
      },
      (record) => record["anchor"] !== undefined,
    );

    const result = invoke(["validate", path]);

    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stdout).toContain("unreadable as a model");
    // The reason and its location, both of which the first-line form dropped.
    expect(result.stdout).toContain("anchor");
    expect(result.stdout).toMatch(/line \d+/);
  });

  /**
   * A reference is a surrogate into this file's own entity section, so an edge
   * that points at nothing is a MALFORMED FILE, not a valid file with a bad
   * reference. v1 could write one and have the analyzer report it afterwards.
   */
  it("refuses a surrogate that resolves to no entity, naming the closure rule", () => {
    const path = corruptedRecord("dangling.jsonl", "x", (record) => {
      record["o"] = 999_999;
    });

    const result = invoke(["validate", path]);

    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stdout).toContain("unreadable as a model");
    expect(result.stdout).toContain("closure");
  });

  it("never orphans a schema complaint from its location when it truncates", () => {
    // A record missing every required key produces more issues than the text
    // form prints; the cut must not strand a "✖" line without its "→ at" line.
    const path = join(scratch, "empty-record.jsonl");
    const header = readFileSync(FIXTURE, "utf8").split("\n")[0]!;
    // Every key of the wrong type at once, so the report has more to say than
    // it prints — which is the case the truncation notice exists for.
    const wrong = {
      t: "e",
      i: "x",
      k: "x",
      tr: "x",
      m: "x",
      s: 1,
      d: 2,
      name: 3,
      signature: 4,
      parent: "x",
      declaredType: "x",
      attachedTo: "x",
      parameters: "x",
      localVariables: "x",
      definedIn: "x",
      comments: "x",
      isStub: "x",
      anchor: "x",
    };
    writeFileSync(path, `${header}\n${JSON.stringify(wrong)}\n`, "utf8");

    const result = invoke(["validate", path]);

    expect(result.code).toBe(EXIT.FINDINGS);
    const detail = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("✖") || line.startsWith("→"));
    expect(detail.length).toBeGreaterThan(0);
    // Every complaint is immediately followed by its location.
    for (let i = 0; i < detail.length; i += 2) {
      expect(detail[i]?.startsWith("✖")).toBe(true);
      expect(detail[i + 1]?.startsWith("→")).toBe(true);
    }
    expect(result.stdout).toContain("run with --json for the whole message");
  });

  it("still validates the readable models alongside an unreadable one", () => {
    const bad = join(scratch, "broken.json");
    writeFileSync(bad, "nope", "utf8");
    const result = invoke(["validate", bad, FIXTURE]);

    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stdout).toContain("169 entities");
    expect(result.stdout).toContain("unreadable as a model");
  });

  it("exits 2 — not 3 — when a path cannot be read at all", () => {
    const result = invoke(["validate", join(scratch, "absent.json")]);

    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("codegraph: cannot read");
  });

  it("loads several models as ONE union (decision 5)", () => {
    const result = invoke(["validate", FIXTURE, FIXTURE, "--json"]);
    const report = JSON.parse(result.stdout) as {
      subject: { models: number; entities: number };
      counts: { byCode: Record<string, number> };
    };

    expect(report.subject.models).toBe(2);
    expect(report.subject.entities).toBe(338);
    // The same file twice redeclares every id identically, which is legal.
    expect(report.counts.byCode["duplicate-id-conflict"]).toBeUndefined();
  });
});
