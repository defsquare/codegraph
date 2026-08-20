import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit.js";
import { parseCsv, parseJsonArtifact, parsePureDot } from "./artifact-grammar.js";
import { createBrokenModels, scratchPath } from "./broken-models.js";
import {
  describeResult,
  ensureCliBinary,
  javaFixture,
  runCli,
  runCliRedirectingStdout,
} from "./cli-process.js";

/**
 * `codegraph export model.json --format dot > graph.dot`.
 *
 * This is the sentence decision 3 exists to make true, so it is tested as
 * written: the child's file descriptor 1 IS the file. No capture, no buffer, no
 * post-processing in the test — if the CLI writes one human word to stdout, it
 * lands in `graph.dot` and the parse fails, exactly as it would for the user.
 */

const models = createBrokenModels();
const FIXTURE = javaFixture();

beforeAll(ensureCliBinary, 120_000);
afterAll(() => models.cleanup());

describe("a redirected stdout is a usable file on its own", () => {
  it("> graph.dot produces a file that parses as DOT", () => {
    const path = scratchPath(models, "graph.dot");
    const result = runCliRedirectingStdout(["export", FIXTURE, "--format", "dot"], path);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);

    const written = readFileSync(path, "utf8");
    const dot = parsePureDot(written);
    expect(dot.directed).toBe(true);
    expect(dot.name).toBe("codegraph");
    expect(dot.edges.length).toBeGreaterThanOrEqual(14);
    expect(written.endsWith("\n")).toBe(true);
  });

  it("> graph.csv produces a file that parses as CSV", () => {
    const path = scratchPath(models, "graph.csv");
    const result = runCliRedirectingStdout(["export", FIXTURE, "--format", "csv"], path);
    expect(result.code).toBe(EXIT.OK);
    const table = parseCsv(readFileSync(path, "utf8"));
    expect(table.rows.length).toBe(14);
  });

  it("> graph.json produces a file that parses as JSON", () => {
    const path = scratchPath(models, "graph.json");
    const result = runCliRedirectingStdout(["export", FIXTURE, "--format", "json"], path);
    expect(result.code).toBe(EXIT.OK);
    const json = parseJsonArtifact(readFileSync(path, "utf8"), "redirected json");
    expect(json["kind"]).toBe("codegraph.foldedGraph/1");
  });

  it("keeps the warnings out of the redirected file and on the terminal", () => {
    const path = scratchPath(models, "warned.dot");
    const result = runCliRedirectingStdout(["export", FIXTURE, "--format", "dot"], path);
    // Folding drops 5 unplaceable edges; the user must hear about it, and the
    // file must not contain it.
    expect(result.stderr).toMatch(/drop/i);
    expect(() => parsePureDot(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("writes a usable artifact even when the model has findings", () => {
    const path = scratchPath(models, "from-broken-model.dot");
    const result = runCliRedirectingStdout(
      ["export", models.danglingReference, "--format", "dot"],
      path,
    );
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(() => parsePureDot(readFileSync(path, "utf8"))).not.toThrow();
    expect(result.stderr.trim()).not.toBe("");
  });

  it("redirection and capture agree byte for byte", () => {
    const path = scratchPath(models, "compared.dot");
    runCliRedirectingStdout(["export", FIXTURE, "--format", "dot"], path);
    const captured = runCli(["export", FIXTURE, "--format", "dot"]);
    expect(readFileSync(path, "utf8")).toBe(captured.stdout);
  });

  it("--out FILE and > FILE produce the same bytes", () => {
    const redirected = scratchPath(models, "via-redirect.dot");
    const explicit = scratchPath(models, "via-out-flag.dot");
    runCliRedirectingStdout(["export", FIXTURE, "--format", "dot"], redirected);
    const result = runCli(["export", FIXTURE, "--format", "dot", "--out", explicit]);
    expect(result.code, describeResult(result)).toBe(EXIT.OK);
    expect(readFileSync(explicit, "utf8")).toBe(readFileSync(redirected, "utf8"));
  });

  it("a failed invocation leaves the redirected file empty", () => {
    const path = scratchPath(models, "usage-error.dot");
    const result = runCliRedirectingStdout(["export", FIXTURE, "--format", "svg"], path);
    expect(result.code).toBe(EXIT.USAGE);
    expect(readFileSync(path, "utf8"), "a usage error must not write a partial artifact").toBe("");
    expect(result.stderr.trim()).not.toBe("");
  });
});
