import { describe, expect, it } from "vitest";
import { clientFromEnv, isConfigured, missingVariables, resolveProvider } from "../src/providers.js";

const OR = { OPENROUTER_API_KEY: "sk-or" };
const CF = { CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acc" };

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
