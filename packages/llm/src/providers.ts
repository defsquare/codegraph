import type { LlmClient } from "./client.js";
import { cloudflareGatewayClient } from "./cloudflare.js";
import { openRouterClient } from "./openrouter.js";
import type { RetryOptions } from "./retry.js";

/**
 * WHICH PROVIDER, decided from the environment in ONE place. A caller passes
 * `auto` or a name; it gets back a client or the exact variables it lacks —
 * never a half-configured client that fails on the first call.
 *
 * `auto` picks the single provider that is configured. When both are, it
 * keeps OpenRouter — the historical default, whose model slugs the docs use —
 * and says so, so routing through AI Gateway is always an explicit `--provider`.
 */

export const PROVIDERS = ["openrouter", "cloudflare"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ProviderChoice = Provider | "auto";

export const PROVIDER_VARIABLES: Readonly<Record<Provider, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  openrouter: { required: ["OPENROUTER_API_KEY"], optional: [] },
  cloudflare: { required: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], optional: ["CLOUDFLARE_AI_GATEWAY_ID"] },
};

export type Env = Readonly<Record<string, string | undefined>>;

function present(env: Env, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

export function missingVariables(provider: Provider, env: Env): string[] {
  return PROVIDER_VARIABLES[provider].required.filter((name) => !present(env, name));
}

export function isConfigured(provider: Provider, env: Env): boolean {
  return missingVariables(provider, env).length === 0;
}

export interface ProviderResolution {
  readonly provider: Provider;
  /** Variables the chosen provider still lacks; empty means a client can be built. */
  readonly missing: readonly string[];
  /** A one-line explanation of the choice, for the human stream. */
  readonly reason: string;
}

export function resolveProvider(choice: ProviderChoice, env: Env): ProviderResolution {
  if (choice !== "auto") {
    return { provider: choice, missing: missingVariables(choice, env), reason: `--provider ${choice}` };
  }
  const configured = PROVIDERS.filter((p) => isConfigured(p, env));
  if (configured.length === 1) {
    const provider = configured[0]!;
    return { provider, missing: [], reason: `${PROVIDER_VARIABLES[provider].required.join(" + ")} set` };
  }
  if (configured.length > 1) {
    return {
      provider: "openrouter",
      missing: [],
      reason: "both OpenRouter and Cloudflare are configured; using OpenRouter (pass --provider cloudflare to route through AI Gateway)",
    };
  }
  return {
    provider: "openrouter",
    missing: missingVariables("openrouter", env),
    reason: "no provider configured",
  };
}

export interface ClientOptions {
  readonly retry?: RetryOptions;
}

/** Build the client for a RESOLVED provider; throws when a required variable is missing. */
export function clientFromEnv(provider: Provider, env: Env, options: ClientOptions = {}): LlmClient {
  const missing = missingVariables(provider, env);
  if (missing.length > 0) throw new Error(`${provider}: missing ${missing.join(", ")}`);
  switch (provider) {
    case "openrouter":
      return openRouterClient({ apiKey: env["OPENROUTER_API_KEY"]!, ...(options.retry === undefined ? {} : { retry: options.retry }) });
    case "cloudflare": {
      const gatewayId = env["CLOUDFLARE_AI_GATEWAY_ID"];
      return cloudflareGatewayClient({
        apiToken: env["CLOUDFLARE_API_TOKEN"]!,
        accountId: env["CLOUDFLARE_ACCOUNT_ID"]!,
        ...(gatewayId === undefined || gatewayId.trim() === "" ? {} : { gatewayId: gatewayId.trim() }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
      });
    }
  }
}
