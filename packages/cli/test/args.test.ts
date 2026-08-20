import { describe, expect, it } from "vitest";
import {
  ANALYZE_SPEC,
  COMMAND_NAMES,
  COMMAND_SPECS,
  DEFAULT_LEVEL,
  EXPORT_SPEC,
  flagSyntax,
  optionSummary,
  parseInvocation,
  PROFILES_SPEC,
  renderHelp,
  usageLine,
  VALIDATE_SPEC,
  type Invocation,
} from "../src/args.js";
import { EXIT, UsageError } from "../src/exit.js";

/** Parse, or fail the test with what came back instead. */
function parse(argv: readonly string[]): Invocation {
  return parseInvocation(argv);
}

function usageErrorFor(argv: readonly string[]): UsageError {
  try {
    parseInvocation(argv);
  } catch (error) {
    expect(error, `expected a UsageError for: codegraph ${argv.join(" ")}`).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error(`expected 'codegraph ${argv.join(" ")}' to be a usage error`);
}

describe("the option specs are data", () => {
  it("covers every command name exactly once", () => {
    expect(COMMAND_SPECS.map((spec) => spec.name)).toEqual([...COMMAND_NAMES]);
  });

  it("describes every option and gives value options a value shape", () => {
    for (const spec of COMMAND_SPECS) {
      for (const option of spec.options) {
        expect(option.describe.length, `${spec.name} --${option.name}`).toBeGreaterThan(0);
        if (option.type === "string") {
          const hasShape = option.choices !== undefined || option.placeholder !== undefined;
          expect(hasShape, `${spec.name} --${option.name} needs choices or a placeholder`).toBe(true);
        }
        if (option.choices !== undefined) expect(option.choices.length).toBeGreaterThan(1);
        if (option.defaultValue !== undefined && option.choices !== undefined) {
          expect(option.choices).toContain(option.defaultValue);
        }
      }
    }
  });

  it("renders help from the specs, so help cannot promise a flag the parser rejects", () => {
    for (const spec of COMMAND_SPECS) {
      const help = renderHelp(spec);
      for (const option of spec.options) expect(help).toContain(`--${option.name}`);
      expect(help).toContain(usageLine(spec));
      expect(help).toContain("--help");
    }
  });

  it("names every command in the global help", () => {
    const help = renderHelp(undefined);
    for (const name of COMMAND_NAMES) expect(help).toContain(name);
    expect(help).toContain("--version");
  });

  it("renders a flag's syntax from its spec", () => {
    expect(flagSyntax({ name: "json", type: "boolean", describe: "" })).toBe("--json");
    expect(flagSyntax({ name: "out", type: "string", describe: "", placeholder: "FILE" })).toBe("--out FILE");
    expect(flagSyntax({ name: "level", type: "string", describe: "", choices: ["a", "b"] })).toBe(
      "--level <a|b>",
    );
  });

  it("summarises a command's options for an error message", () => {
    const summary = optionSummary(ANALYZE_SPEC);
    expect(summary).toContain("--report <deps|cycles|coupling>");
    expect(summary).toContain("--top N");
  });
});

describe("global parsing", () => {
  it("treats --help and -h as a request for the global help", () => {
    expect(parse(["--help"])).toEqual({ kind: "help", command: undefined });
    expect(parse(["-h"])).toEqual({ kind: "help", command: undefined });
  });

  it("treats --version and -v as a version request", () => {
    expect(parse(["--version"])).toEqual({ kind: "version" });
    expect(parse(["-v"])).toEqual({ kind: "version" });
  });

  it("rejects an empty argv, naming the commands", () => {
    const error = usageErrorFor([]);
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(`${error.message} ${error.hint ?? ""}`).toContain("analyze");
  });

  it("rejects an unknown command, naming the valid ones", () => {
    const error = usageErrorFor(["anlyze", "model.jsonl"]);
    expect(error.message).toContain("anlyze");
    expect(error.hint ?? "").toContain("validate, analyze, export, profiles");
  });

  it("rejects an unknown global option, naming what is global", () => {
    const error = usageErrorFor(["--report"]);
    expect(error.message).toContain("--report");
    expect(error.hint ?? "").toContain("--help");
  });

  it("gives a command its own help, even when the rest of the line is invalid", () => {
    expect(parse(["analyze", "--help"])).toEqual({ kind: "help", command: ANALYZE_SPEC });
    expect(parse(["analyze", "--nonsense", "--help"])).toEqual({ kind: "help", command: ANALYZE_SPEC });
  });
});

describe("validate", () => {
  it("takes one or more models and --json", () => {
    expect(parse(["validate", "a.json", "b.json", "--json"])).toEqual({
      kind: "run",
      command: "validate",
      options: { models: ["a.json", "b.json"], json: true },
    });
  });

  it("defaults --json to false", () => {
    const invocation = parse(["validate", "a.json"]);
    expect(invocation).toMatchObject({ command: "validate", options: { json: false } });
  });

  it("requires at least one model path", () => {
    const error = usageErrorFor(["validate"]);
    expect(error.message).toContain("model.jsonl");
    expect(error.hint ?? "").toContain(usageLine(VALIDATE_SPEC));
  });

  it("rejects an unknown flag, naming the valid options", () => {
    const error = usageErrorFor(["validate", "a.json", "--jsonn"]);
    expect(error.hint ?? "").toContain("--json");
  });
});

describe("analyze", () => {
  it("parses every option, camel-casing the two-word flags", () => {
    expect(
      parse([
        "analyze",
        "a.json",
        "--report",
        "coupling",
        "--level",
        "type",
        "--internal-only",
        "--declared-only",
        "--top",
        "5",
        "--json",
      ]),
    ).toEqual({
      kind: "run",
      command: "analyze",
      options: {
        models: ["a.json"],
        report: "coupling",
        level: "type",
        internalOnly: true,
        declaredOnly: true,
        top: 5,
        json: true,
      },
    });
  });

  it("defaults the level to module and leaves --top unset", () => {
    expect(parse(["analyze", "a.json", "--report", "deps"])).toEqual({
      kind: "run",
      command: "analyze",
      options: {
        models: ["a.json"],
        report: "deps",
        level: DEFAULT_LEVEL,
        internalOnly: false,
        declaredOnly: false,
        top: undefined,
        json: false,
      },
    });
  });

  it("requires --report", () => {
    const error = usageErrorFor(["analyze", "a.json"]);
    expect(error.message).toContain("--report");
    expect(error.message).toContain("deps|cycles|coupling");
  });

  it("rejects a value outside the closed set, naming the set", () => {
    const error = usageErrorFor(["analyze", "a.json", "--report", "depps"]);
    expect(error.message).toContain("depps");
    expect(error.hint ?? "").toContain("deps, cycles, coupling");
  });

  it("rejects a level the analyzer cannot fold to", () => {
    const error = usageErrorFor(["analyze", "a.json", "--report", "deps", "--level", "package"]);
    expect(error.hint ?? "").toContain("module");
  });

  it("rejects a --top that is not a whole number >= 1", () => {
    for (const bad of ["0", "-3", "2.5", "ten"]) {
      const error = usageErrorFor(["analyze", "a.json", "--report", "deps", "--top", bad]);
      expect(error.message, bad).toContain("--top");
    }
  });

  it("rejects --report without a value", () => {
    const error = usageErrorFor(["analyze", "a.json", "--report"]);
    expect(error.exitCode).toBe(EXIT.USAGE);
  });
});

describe("export", () => {
  it("parses format, level, views and --out", () => {
    expect(parse(["export", "a.json", "--format", "dot", "--out", "graph.dot", "--internal-only"])).toEqual({
      kind: "run",
      command: "export",
      options: {
        models: ["a.json"],
        format: "dot",
        level: DEFAULT_LEVEL,
        internalOnly: true,
        declaredOnly: false,
        out: "graph.dot",
      },
    });
  });

  it("requires --format", () => {
    const error = usageErrorFor(["export", "a.json"]);
    expect(error.message).toContain("--format");
    expect(error.hint ?? "").toContain(usageLine(EXPORT_SPEC));
  });

  it("rejects an unknown format", () => {
    const error = usageErrorFor(["export", "a.json", "--format", "graphml"]);
    expect(error.hint ?? "").toContain("dot, json, csv, plantuml");
  });
});

describe("profiles", () => {
  it("takes no model and defaults both options to unset", () => {
    expect(parse(["profiles"])).toEqual({
      kind: "run",
      command: "profiles",
      options: { lang: undefined, json: false },
    });
  });

  it("takes --lang and --json", () => {
    expect(parse(["profiles", "--lang", "java", "--json"])).toEqual({
      kind: "run",
      command: "profiles",
      options: { lang: "java", json: true },
    });
  });

  it("rejects a positional argument, in the command's own words", () => {
    const error = usageErrorFor(["profiles", "model.jsonl"]);
    expect(error.message).toContain("no positional arguments");
    expect(error.hint ?? "").toContain(usageLine(PROFILES_SPEC));
  });
});

describe("parseArgs errors are re-said in codegraph's terms", () => {
  it("keeps the problem and drops node's advice about '--'", () => {
    const error = usageErrorFor(["analyze", "a.json", "--repot", "deps"]);
    expect(error.message).toBe("unknown option '--repot' for 'codegraph analyze'");
    expect(error.message).not.toContain("place it at the end");
    expect(error.hint ?? "").toContain("--report <deps|cycles|coupling>");
  });

  it("says which option is missing its value", () => {
    const error = usageErrorFor(["export", "a.json", "--out"]);
    expect(error.message).toContain("--out");
  });
});
