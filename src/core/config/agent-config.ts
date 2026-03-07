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

export function loadRuntimeConfig(): RuntimeConfig {
  const stored = loadConfigBundle();
  const providerConfig = requireProviderConfig(stored);
  const agentConfig = selectAgentConfig(stored);

  return {
    model: {
      baseURL: requireStoredValue(providerConfig.baseURL, "providers[].baseURL"),
      apiKey: providerConfig.apiKey ?? "dummy",
      model: requireStoredValue(providerConfig.model, "providers[].model"),
      profile: providerConfig.profile,
      temperature: providerConfig.temperature,
      maxTokens: providerConfig.maxTokens,
    },
    workspaceRoot: stored.workspace?.workspaceRoot || getWorkspaceRoot(),
    activeSkillIds: agentConfig?.activeSkillIds?.length
      ? agentConfig.activeSkillIds
      : ["workspace_operator"],
    globalPolicy: stored.system?.globalPolicy
      ?? "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
    stateSummary: stored.system?.stateSummary,
    memorySummary: stored.system?.memorySummary,
    maxIterations: stored.system?.maxIterations ?? 8,
    debugModelMessages: stored.system?.debugModelMessages ?? false,
    gatewayPort: stored.system?.gatewayPort ?? 5050,
  };
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

function requireProviderConfig(stored: ReturnType<typeof loadConfigBundle>) {
  const provider = selectProviderConfig(stored);
  if (!provider) {
    throw new Error("Missing provider configuration. Run `malikraw onboard` first.");
  }

  return provider;
}

function requireStoredValue(value: string | undefined, fieldPath: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required config value ${fieldPath}. Run \`malikraw onboard\` to update your config.`);
  }

  return trimmed;
}
