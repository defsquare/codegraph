import { describe, expect, it } from "vitest";
import type { ClaudeCodeDiscovery } from "../src/claude-code-discovery.js";
import { CLAUDE_CODE_SCAFFOLD_TOKENS } from "../src/claude-code.js";
import { clientFromEnv, clientFromResolution, isConfigured, missingVariables, promptOverhead, resolveProvider } from "../src/providers.js";

const OR = { OPENROUTER_API_KEY: "sk-or" };
const CF = { CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acc" };
const CLAUDE = "/home/me/.local/bin/claude";
const FOUND: ClaudeCodeDiscovery = { location: { path: CLAUDE, source: "PATH" }, reason: "found on PATH" };
const NOT_FOUND: ClaudeCodeDiscovery = { location: undefined, reason: "no claude on PATH or in a known install location" };

describe("promptOverhead", () => {
  it("is nothing on the key adapters; on Claude Code, its scaffolding per call with the response schema in the prompt", () => {
    expect(promptOverhead("openrouter")).toEqual({ perCall: 0, schema: false });
    expect(promptOverhead("cloudflare")).toEqual({ perCall: 0, schema: false });
    expect(promptOverhead("claude-code")).toEqual({ perCall: CLAUDE_CODE_SCAFFOLD_TOKENS, schema: true });
  });

  it("keeps Claude Code's scaffolding inside what the live run measured", () => {
    // Java fixture, 2.1.322, 48 operation calls: billed − estimated prompt = +2 292…+2 617,
    // less the ~498-token operation schema → 1 794…2 119 of scaffolding.
    expect(CLAUDE_CODE_SCAFFOLD_TOKENS).toBeGreaterThanOrEqual(1794);
    expect(CLAUDE_CODE_SCAFFOLD_TOKENS).toBeLessThanOrEqual(2119);
  });
});

describe("resolveProvider", () => {
  it("auto picks the one provider that is configured", () => {
    expect(resolveProvider("auto", OR)).toMatchObject({ provider: "openrouter", missing: [] });
    expect(resolveProvider("auto", CF)).toMatchObject({ provider: "cloudflare", missing: [] });
  });

  it("auto keeps OpenRouter when both are configured, and says why", () => {
    const resolution = resolveProvider("auto", { ...OR, ...CF });
    expect(resolution.provider).toBe("openrouter");
    expect(resolution.reason).toContain("--provider cloudflare");
  });

  it("auto with nothing configured names OpenRouter's variable as missing", () => {
    expect(resolveProvider("auto", {})).toEqual({ provider: "openrouter", missing: ["OPENROUTER_API_KEY"], reason: "no provider configured" });
  });

  it("an explicit choice wins and reports exactly what it lacks", () => {
    expect(resolveProvider("cloudflare", OR)).toMatchObject({ provider: "cloudflare", missing: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] });
    expect(resolveProvider("cloudflare", { ...CF, CLOUDFLARE_ACCOUNT_ID: "  " }).missing).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    expect(resolveProvider("openrouter", CF)).toMatchObject({ provider: "openrouter", missing: ["OPENROUTER_API_KEY"] });
    expect(isConfigured("cloudflare", CF)).toBe(true);
    expect(missingVariables("openrouter", {})).toEqual(["OPENROUTER_API_KEY"]);
  });
});

describe("clientFromEnv", () => {
  it("builds the named client, with the gateway id when set", () => {
    expect(clientFromEnv("openrouter", OR).name).toBe("openrouter");
    expect(clientFromEnv("cloudflare", CF).name).toBe("cloudflare");
    expect(clientFromEnv("cloudflare", { ...CF, CLOUDFLARE_AI_GATEWAY_ID: "prod" }).name).toBe("cloudflare/prod");
  });

  it("refuses to build a half-configured client", () => {
    expect(() => clientFromEnv("cloudflare", OR)).toThrow(/CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID/);
  });
});

describe("claude-code in resolution", () => {
  it("is configured only when the probe found a binary; what it lacks is the one variable that points at one", () => {
    expect(isConfigured("claude-code", {}, { claudeCode: FOUND })).toBe(true);
    expect(isConfigured("claude-code", {}, { claudeCode: NOT_FOUND })).toBe(false);
    expect(isConfigured("claude-code", { CLAUDE_CODE_PATH: CLAUDE })).toBe(false);
    expect(missingVariables("claude-code", {}, { claudeCode: NOT_FOUND })).toEqual(["CLAUDE_CODE_PATH"]);
    expect(missingVariables("claude-code", {}, { claudeCode: FOUND })).toEqual([]);
  });

  it("auto picks it when it is the only one, with how it was found and where in the reason", () => {
    const resolution = resolveProvider("auto", {}, { claudeCode: FOUND });
    expect(resolution).toMatchObject({ provider: "claude-code", missing: [], claudeCode: FOUND.location });
    expect(resolution.reason).toContain("found on PATH");
    expect(resolution.reason).toContain(CLAUDE);
    expect(resolveProvider("auto", {}, { claudeCode: NOT_FOUND })).toEqual({ provider: "openrouter", missing: ["OPENROUTER_API_KEY"], reason: "no provider configured" });
  });

  it("auto prefers an exported key over the installed CLI — OpenRouter, then Cloudflare — and names --provider claude-code", () => {
    const withOpenRouter = resolveProvider("auto", OR, { claudeCode: FOUND });
    expect(withOpenRouter.provider).toBe("openrouter");
    expect(withOpenRouter.reason).toContain("--provider claude-code");
    expect(withOpenRouter.claudeCode).toBeUndefined();
    const withCloudflare = resolveProvider("auto", CF, { claudeCode: FOUND });
    expect(withCloudflare.provider).toBe("cloudflare");
    expect(withCloudflare.reason).toContain("--provider claude-code");
    const all = resolveProvider("auto", { ...OR, ...CF }, { claudeCode: FOUND });
    expect(all.provider).toBe("openrouter");
    expect(all.reason).toContain("--provider cloudflare");
    expect(all.reason).toContain("--provider claude-code");
  });

  it("--provider claude-code with a binary found mentions the path; without one, lists CLAUDE_CODE_PATH and the discovery's reason", () => {
    const found = resolveProvider("claude-code", OR, { claudeCode: FOUND });
    expect(found).toMatchObject({ provider: "claude-code", missing: [], claudeCode: FOUND.location });
    expect(found.reason).toContain("--provider claude-code");
    expect(found.reason).toContain(CLAUDE);
    const missing = resolveProvider("claude-code", OR, { claudeCode: NOT_FOUND });
    expect(missing).toMatchObject({ provider: "claude-code", missing: ["CLAUDE_CODE_PATH"], reason: NOT_FOUND.reason });
    expect(missing.claudeCode).toBeUndefined();
    const explicit = resolveProvider("claude-code", {}, { claudeCode: { location: undefined, reason: "--claude-path /nowhere/claude does not exist" } });
    expect(explicit.reason).toBe("--claude-path /nowhere/claude does not exist");
    expect(resolveProvider("claude-code", {}).missing).toEqual(["CLAUDE_CODE_PATH"]);
  });

  it("clientFromEnv builds a client named claude-code from the location, and refuses without one", () => {
    expect(clientFromEnv("claude-code", {}, { claudeCode: FOUND.location }).name).toBe("claude-code");
    expect(() => clientFromEnv("claude-code", { CLAUDE_CODE_PATH: CLAUDE })).toThrow(/CLAUDE_CODE_PATH|--claude-path/u);
  });

  it("clientFromResolution round-trips the resolved location into the client", () => {
    const resolution = resolveProvider("claude-code", {}, { claudeCode: FOUND });
    expect(clientFromResolution(resolution, {}).name).toBe("claude-code");
    expect(clientFromResolution(resolveProvider("auto", OR, { claudeCode: FOUND }), OR).name).toBe("openrouter");
    expect(() => clientFromResolution(resolveProvider("claude-code", {}, { claudeCode: NOT_FOUND }), {})).toThrow(/CLAUDE_CODE_PATH/u);
  });
});
