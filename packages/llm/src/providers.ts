import { claudeCodeClient } from "./claude-code.js";
import { CLAUDE_CODE_PATH_VARIABLE, type ClaudeCodeDiscovery, type ClaudeCodeLocation } from "./claude-code-discovery.js";
import type { LlmClient } from "./client.js";
import { cloudflareGatewayClient } from "./cloudflare.js";
import { openRouterClient } from "./openrouter.js";
import type { RetryOptions } from "./retry.js";

/**
 * WHICH ADAPTER, decided in ONE place. `LlmClient` (client.ts) is the port;
 * openrouter.ts, cloudflare.ts and claude-code.ts are the adapters behind it,
 * and this module is the only one that knows there are three. A caller passes
 * `auto` or a name; it gets back a client or exactly what it lacks — never a
 * half-configured client that fails on the first call.
 *
 * Two kinds of configuration: a key provider is configured when its variables
 * are set; Claude Code when discovery (claude-code-discovery.ts, run by the
 * caller and handed over as the probe) found the binary. `auto` picks the
 * single configured provider. With several, a fixed precedence applies —
 * OpenRouter, then Cloudflare, then Claude Code (the order of `PROVIDERS`):
 * an exported key is a deliberate act, an installed CLI is ambient — and the
 * reason names the flag for each alternative.
 *
 * The fourth adapter, the Anthropic API with an API key, is one more entry
 * here when it comes (PLAN.md §21.6); nothing above the port changes.
 */

export const PROVIDERS = ["openrouter", "cloudflare", "claude-code"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ProviderChoice = Provider | "auto";

export const PROVIDER_VARIABLES: Readonly<Record<Provider, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  openrouter: { required: ["OPENROUTER_API_KEY"], optional: [] },
  cloudflare: { required: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], optional: ["CLOUDFLARE_AI_GATEWAY_ID"] },
  "claude-code": { required: [], optional: [CLAUDE_CODE_PATH_VARIABLE] },
};

export type Env = Readonly<Record<string, string | undefined>>;

/** What resolution knows beyond the environment: the outcome of looking for the Claude Code binary. Absent = not looked for = not configured. */
export interface ProviderProbe {
  readonly claudeCode?: ClaudeCodeDiscovery | undefined;
}

function present(env: Env, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

/** The variables the provider still lacks — for Claude Code, the one way to point at a binary that was not found. */
export function missingVariables(provider: Provider, env: Env, probe: ProviderProbe = {}): string[] {
  if (provider === "claude-code") return probe.claudeCode?.location === undefined ? [CLAUDE_CODE_PATH_VARIABLE] : [];
  return PROVIDER_VARIABLES[provider].required.filter((name) => !present(env, name));
}

export function isConfigured(provider: Provider, env: Env, probe: ProviderProbe = {}): boolean {
  return missingVariables(provider, env, probe).length === 0;
}

export interface ProviderResolution {
  readonly provider: Provider;
  /** Variables the chosen provider still lacks; empty means a client can be built. */
  readonly missing: readonly string[];
  /** A one-line explanation of the choice, for the human stream. */
  readonly reason: string;
  /** The binary, when the provider is `claude-code` and discovery found one. */
  readonly claudeCode?: ClaudeCodeLocation;
}

const LABEL: Readonly<Record<Provider, string>> = { openrouter: "OpenRouter", cloudflare: "Cloudflare", "claude-code": "Claude Code" };
const SWITCH_HINT: Readonly<Record<Provider, string>> = {
  openrouter: "to route through OpenRouter",
  cloudflare: "to route through AI Gateway",
  "claude-code": "to run the local Claude Code",
};

/** How a configured provider got configured, for the reason line. */
function configuredBy(provider: Provider, probe: ProviderProbe): string {
  if (provider === "claude-code") {
    const discovery = probe.claudeCode;
    return discovery?.location === undefined ? "claude not found" : `${discovery.reason}: ${discovery.location.path}`;
  }
  return `${PROVIDER_VARIABLES[provider].required.join(" + ")} set`;
}

export function resolveProvider(choice: ProviderChoice, env: Env, probe: ProviderProbe = {}): ProviderResolution {
  const located = (resolution: Omit<ProviderResolution, "claudeCode">): ProviderResolution => {
    const location = resolution.provider === "claude-code" ? probe.claudeCode?.location : undefined;
    return location === undefined ? resolution : { ...resolution, claudeCode: location };
  };
  if (choice !== "auto") {
    const missing = missingVariables(choice, env, probe);
    const reason =
      choice !== "claude-code"
        ? `--provider ${choice}`
        : missing.length === 0
          ? `--provider claude-code, ${configuredBy(choice, probe)}`
          : (probe.claudeCode?.reason ?? "claude not looked for");
    return located({ provider: choice, missing, reason });
  }
  const configured = PROVIDERS.filter((p) => isConfigured(p, env, probe));
  if (configured.length === 1) {
    const provider = configured[0]!;
    return located({ provider, missing: [], reason: configuredBy(provider, probe) });
  }
  if (configured.length > 1) {
    const [first, ...others] = configured;
    const names = configured.map((p) => LABEL[p]);
    const listed = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const hints = others.map((p) => `--provider ${p} ${SWITCH_HINT[p]}`).join(", or ");
    return located({ provider: first!, missing: [], reason: `${listed} are configured; using ${LABEL[first!]} (pass ${hints})` });
  }
  return {
    provider: "openrouter",
    missing: missingVariables("openrouter", env),
    reason: "no provider configured",
  };
}

export interface ClientOptions {
  readonly retry?: RetryOptions;
  /** For `claude-code`: the binary discovery found. */
  readonly claudeCode?: ClaudeCodeLocation | undefined;
}

/** Build the client for a RESOLVED provider; throws when a required variable (or, for Claude Code, the binary) is missing. */
export function clientFromEnv(provider: Provider, env: Env, options: ClientOptions = {}): LlmClient {
  if (provider === "claude-code") {
    if (options.claudeCode === undefined) throw new Error(`claude-code: no binary (set ${CLAUDE_CODE_PATH_VARIABLE} or pass --claude-path FILE)`);
    return claudeCodeClient({ command: options.claudeCode.path, env, ...(options.retry === undefined ? {} : { retry: options.retry }) });
  }
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

/** The client for a resolution with nothing missing — the one call a command makes after `resolveProvider`. */
export function clientFromResolution(resolution: ProviderResolution, env: Env, options: Omit<ClientOptions, "claudeCode"> = {}): LlmClient {
  if (resolution.missing.length > 0) throw new Error(`${resolution.provider}: missing ${resolution.missing.join(", ")}`);
  return clientFromEnv(resolution.provider, env, { ...options, ...(resolution.claudeCode === undefined ? {} : { claudeCode: resolution.claudeCode }) });
}
