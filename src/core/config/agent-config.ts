import type { ProviderProfile } from "../providers/compatibility-profile.js";
import type { StoredChannelConfig, StoredMemoryConfig } from "./config-store.js";
import { loadConfigBundle } from "./config-store.js";
import { getWorkspaceRoot } from "../../runtime/workspace-context.js";
import type { MemoryConfig } from "../../memory/types.js";

export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
  contextWindow: number;
  maxTokens?: number;
  compact: {
    thresholdTokens: number;
    targetTokens: number;
    instructionPath?: string;
  };
};

export type RuntimeConfig = {
  model: OpenAICompatibleConfig;
  workspaceRoot: string;
  activeSkillIds: string[];
  channels: StoredChannelConfig[];
  defaultAgentId: string;
  agents: RuntimeAgentConfig[];
  globalPolicy: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations?: number;
  debugModelMessages: boolean;
  gatewayPort: number;
  memory?: MemoryConfig;
};

export type RuntimeAgentConfig = {
  id: string;
  model: OpenAICompatibleConfig;
  activeSkillIds: string[];
};

export function loadRuntimeConfig(): RuntimeConfig {
  const stored = loadConfigBundle();
  const providerConfig = requireProviderConfig(stored);
  const agentConfig = selectAgentConfig(stored);
  const agents = resolveRuntimeAgents(stored);
  const defaultAgentId = agentConfig?.id ?? agents[0]?.id ?? "main";

  return {
    model: {
      baseURL: requireStoredValue(providerConfig.baseURL, "providers[].baseURL"),
      apiKey: providerConfig.apiKey ?? "dummy",
      model: requireStoredValue(providerConfig.model, "providers[].model"),
      profile: providerConfig.profile,
      temperature: providerConfig.temperature ?? 0.2,
      contextWindow: providerConfig.contextWindow ?? 32_768,
      maxTokens: providerConfig.maxTokens ?? 4096,
      compact: {
        thresholdTokens: providerConfig.compact?.thresholdTokens
          ?? defaultCompactThreshold(providerConfig.contextWindow ?? 32_768, providerConfig.maxTokens ?? 4096),
        targetTokens: providerConfig.compact?.targetTokens
          ?? defaultCompactTarget(providerConfig.contextWindow ?? 32_768, providerConfig.maxTokens ?? 4096),
        instructionPath: providerConfig.compact?.instructionPath?.trim() || undefined,
      },
    },
    workspaceRoot: stored.workspace?.workspaceRoot || getWorkspaceRoot(),
    activeSkillIds: agentConfig?.activeSkillIds?.length
      ? agentConfig.activeSkillIds
      : [],
    channels: normalizeChannels(stored.channels?.channels),
    defaultAgentId,
    agents,
    globalPolicy: stored.system?.globalPolicy
      ?? "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
    stateSummary: stored.system?.stateSummary,
    memorySummary: stored.system?.memorySummary,
    maxIterations: undefined,
    debugModelMessages: false,
    gatewayPort: stored.system?.gatewayPort ?? 5050,
    memory: normalizeMemoryConfig(stored.memory),
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

function selectProviderConfigForAgent(
  stored: ReturnType<typeof loadConfigBundle>,
  agentId: string,
) {
  const providers = stored.providers?.providers ?? [];
  if (providers.length === 0) {
    return undefined;
  }

  const explicit = stored.agentProviderMapping?.mappings?.[agentId]
    ?? stored.agents?.agents.find((agent) => agent.id === agentId)?.providerId
    ?? stored.agentProviderMapping?.defaultProviderId
    ?? stored.providers?.defaultProviderId;

  return providers.find((provider) => provider.id === explicit)
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

function normalizeChannels(channels: StoredChannelConfig[] | undefined): StoredChannelConfig[] {
  if (!channels || channels.length === 0) {
    return [];
  }

  return channels;
}

function resolveRuntimeAgents(stored: ReturnType<typeof loadConfigBundle>): RuntimeAgentConfig[] {
  const agents = stored.agents?.agents ?? [];
  if (agents.length === 0) {
    const provider = requireProviderConfig(stored);
    return [{
      id: "main",
      model: toModelConfig(provider),
      activeSkillIds: [],
    }];
  }

  return agents.map((agent) => {
    const provider = selectProviderConfigForAgent(stored, agent.id);
    if (!provider) {
      throw new Error(`Missing provider configuration for agent "${agent.id}".`);
    }

    return {
      id: agent.id,
      model: toModelConfig(provider),
      activeSkillIds: agent.activeSkillIds ?? [],
    };
  });
}

function toModelConfig(providerConfig: {
  baseURL: string;
  apiKey?: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
  contextWindow?: number;
  maxTokens?: number;
  compact?: {
    thresholdTokens?: number;
    targetTokens?: number;
    instructionPath?: string;
  };
}): OpenAICompatibleConfig {
  const contextWindow = providerConfig.contextWindow ?? 32_768;
  const maxTokens = providerConfig.maxTokens ?? 4096;
  return {
    baseURL: requireStoredValue(providerConfig.baseURL, "providers[].baseURL"),
    apiKey: providerConfig.apiKey ?? "dummy",
    model: requireStoredValue(providerConfig.model, "providers[].model"),
    profile: providerConfig.profile,
    temperature: providerConfig.temperature ?? 0.2,
    contextWindow,
    maxTokens,
    compact: {
      thresholdTokens: providerConfig.compact?.thresholdTokens
        ?? defaultCompactThreshold(contextWindow, maxTokens),
      targetTokens: providerConfig.compact?.targetTokens
        ?? defaultCompactTarget(contextWindow, maxTokens),
      instructionPath: providerConfig.compact?.instructionPath?.trim() || undefined,
    },
  };
}

function defaultCompactThreshold(contextWindow: number, maxTokens: number): number {
  return Math.min(12_000, Math.max(1024, contextWindow - maxTokens - 1024));
}

function defaultCompactTarget(contextWindow: number, maxTokens: number): number {
  return Math.max(768, Math.floor(defaultCompactThreshold(contextWindow, maxTokens) * 0.6));
}

function normalizeMemoryConfig(stored: StoredMemoryConfig | undefined): MemoryConfig | undefined {
  if (!stored) {
    return undefined;
  }

  if (stored.enabled) {
    const postgresUrl = stored.postgresUrl?.trim();
    const redisUrl = stored.redisUrl?.trim();
    if (!postgresUrl) {
      throw new Error(
        "Enhanced memory is enabled but memory.postgresUrl is missing. "
        + "Run `malikraw onboard` and set Enhanced memory Postgres URL.",
      );
    }
    if (!redisUrl) {
      throw new Error(
        "Enhanced memory is enabled but memory.redisUrl is missing. "
        + "Run `malikraw onboard` and set Enhanced memory Redis URL.",
      );
    }
  }

  return {
    enabled: stored.enabled,
    postgresUrl: stored.postgresUrl?.trim() || undefined,
    redisUrl: stored.redisUrl?.trim() || undefined,
    embeddingModel: stored.embeddingModel,
    embeddingDimensions: stored.embeddingDimensions ?? 1536,
    sessionRecentMessages: stored.sessionRecentMessages ?? 8,
    semanticTopK: stored.semanticTopK ?? 6,
    episodicTopK: stored.episodicTopK ?? 4,
    maxPromptChars: stored.maxPromptChars ?? 2000,
    importanceThreshold: stored.importanceThreshold ?? 0.65,
  };
}
