import type { ProviderProfile } from "../providers/compatibility-profile.js";
import { loadConfigBundle } from "./config-store.js";
import { getWorkspaceRoot } from "../../runtime/workspace-context.js";

export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
  maxTokens?: number;
};

export type RuntimeConfig = {
  model: OpenAICompatibleConfig;
  workspaceRoot: string;
  activeSkillIds: string[];
  globalPolicy: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations: number;
  debugModelMessages: boolean;
  gatewayPort: number;
};

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const stored = loadConfigBundle();
  const providerConfig = selectProviderConfig(stored);
  const agentConfig = selectAgentConfig(stored);

  return {
    model: {
      baseURL: env.OPENAI_BASE_URL?.trim() || providerConfig?.baseURL || requireEnv(env, "OPENAI_BASE_URL"),
      apiKey: env.OPENAI_API_KEY ?? providerConfig?.apiKey ?? "dummy",
      model: env.OPENAI_MODEL?.trim() || providerConfig?.model || requireEnv(env, "OPENAI_MODEL"),
      profile: parseProfile(env.OPENAI_COMPAT_PROFILE) ?? providerConfig?.profile,
      temperature: parseOptionalNumber(env.OPENAI_TEMPERATURE) ?? providerConfig?.temperature,
      maxTokens: parseOptionalNumber(env.OPENAI_MAX_TOKENS) ?? providerConfig?.maxTokens,
    },
    workspaceRoot: env.MALIKRAW_WORKSPACE?.trim() || stored.workspace?.workspaceRoot || getWorkspaceRoot(),
    activeSkillIds: parseList(env.ACTIVE_SKILLS).length > 0
      ? parseList(env.ACTIVE_SKILLS)
      : agentConfig?.activeSkillIds?.length
        ? agentConfig.activeSkillIds
        : ["workspace_operator"],
    globalPolicy: env.GLOBAL_AGENT_POLICY?.trim()
      ?? stored.system?.globalPolicy
      ?? "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
    stateSummary: emptyToUndefined(env.STATE_SUMMARY) ?? stored.system?.stateSummary,
    memorySummary: emptyToUndefined(env.MEMORY_SUMMARY) ?? stored.system?.memorySummary,
    maxIterations: parseOptionalNumber(env.MAX_ITERATIONS) ?? stored.system?.maxIterations ?? 8,
    debugModelMessages: parseBoolean(env.DEBUG_MODEL_MESSAGES) ?? stored.system?.debugModelMessages ?? false,
    gatewayPort: parseOptionalNumber(env.GATEWAY_PORT) ?? stored.system?.gatewayPort ?? 5050,
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${key}.`);
  }

  return value;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received "${value}".`);
  }

  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }

  throw new Error(`Expected a boolean-like value, received "${value}".`);
}

function parseProfile(value: string | undefined): ProviderProfile | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "openai" || value === "deepseek" || value === "qwen") {
    return value;
  }

  throw new Error(`Unsupported OPENAI_COMPAT_PROFILE "${value}". Expected "openai", "deepseek", or "qwen".`);
}

function selectProviderConfig(stored: ReturnType<typeof loadConfigBundle>) {
  const providers = stored.providers?.providers ?? [];
  if (providers.length === 0) {
    return undefined;
  }

  const mappedProviderId = resolveProviderId(stored);
  return providers.find((provider) => provider.id === mappedProviderId)
    ?? providers.find((provider) => provider.id === stored.providers?.defaultProviderId)
    ?? providers[0];
}

function resolveProviderId(stored: ReturnType<typeof loadConfigBundle>): string | undefined {
  const defaultAgentId = stored.agents?.defaultAgentId;
  if (defaultAgentId) {
    const explicit = stored.agentProviderMapping?.mappings?.[defaultAgentId];
    if (explicit) {
      return explicit;
    }

    const agentProvider = stored.agents?.agents.find((agent) => agent.id === defaultAgentId)?.providerId;
    if (agentProvider) {
      return agentProvider;
    }
  }

  return stored.agentProviderMapping?.defaultProviderId ?? stored.providers?.defaultProviderId;
}

function selectAgentConfig(stored: ReturnType<typeof loadConfigBundle>) {
  const defaultAgentId = stored.agents?.defaultAgentId;
  if (!defaultAgentId) {
    return stored.agents?.agents[0];
  }

  return stored.agents?.agents.find((agent) => agent.id === defaultAgentId) ?? stored.agents?.agents[0];
}
