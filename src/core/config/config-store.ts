import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProviderProfile } from "../providers/compatibility-profile.js";

export type StoredSystemConfig = {
  gatewayPort: number;
  globalPolicy?: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations?: number;
  debugModelMessages?: boolean;
};

export type StoredMemoryConfig = {
  enabled: boolean;
  postgresUrl?: string;
  redisUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  sessionRecentMessages?: number;
  semanticTopK?: number;
  episodicTopK?: number;
  maxPromptChars?: number;
  importanceThreshold?: number;
};

export type StoredProviderConfig = {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
  maxTokens?: number;
};

export type StoredProvidersConfig = {
  defaultProviderId: string;
  providers: StoredProviderConfig[];
};

export type StoredAgentProviderMappingConfig = {
  defaultProviderId: string;
  mappings: Record<string, string>;
};

export type StoredWorkspaceConfig = {
  workspaceRoot: string;
};

export type StoredHttpChannelConfig = {
  id: string;
  type: "http";
  agentId?: string;
};

export type StoredFeishuChannelConfig = {
  id: string;
  type: "feishu";
  appId: string;
  appSecret: string;
  agentId?: string;
  verificationToken?: string;
  encryptKey?: string;
  replyMode?: "chat" | "reply" | "thread";
  messageFormat?: "text" | "interactive";
  autoReplyInThread?: boolean;
};

export type StoredChannelConfig = StoredHttpChannelConfig | StoredFeishuChannelConfig;

export type StoredChannelsConfig = {
  defaultChannelId: string;
  channels: StoredChannelConfig[];
};

export type StoredToolsConfig = {
  braveSearchApiKey?: string;
};

export type StoredAgentConfig = {
  id: string;
  activeSkillIds: string[];
  providerId?: string;
};

export type StoredAgentsConfig = {
  defaultAgentId: string;
  agents: StoredAgentConfig[];
};

export type StoredAgentCard = {
  agentId: string;
  description: string;
  taskKinds: string[];
  capabilities: string[];
  constraints?: {
    maxDurationSec?: number;
    maxInputChars?: number;
    costTier?: "low" | "medium" | "high";
  };
};

export type StoredAgentCardsConfig = {
  agents: StoredAgentCard[];
};

export type MalikrawConfigBundle = {
  system?: StoredSystemConfig;
  providers?: StoredProvidersConfig;
  agentProviderMapping?: StoredAgentProviderMappingConfig;
  workspace?: StoredWorkspaceConfig;
  channels?: StoredChannelsConfig;
  tools?: StoredToolsConfig;
  agents?: StoredAgentsConfig;
  agentCards?: StoredAgentCardsConfig;
  memory?: StoredMemoryConfig;
};

export function getMalikrawHomeDirectory(): string {
  return process.env.MALIKRAW_HOME?.trim() || path.join(homedir(), ".malikraw");
}

export function getConfigDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), "config");
}

export function ensureConfigDirectory(): string {
  const directory = getConfigDirectory();
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function loadConfigBundle(): MalikrawConfigBundle {
  return {
    system: readJsonFile<StoredSystemConfig>("system.json"),
    providers: readJsonFile<StoredProvidersConfig>("providers.json"),
    agentProviderMapping: readJsonFile<StoredAgentProviderMappingConfig>("agent-provider-mapping.json"),
    workspace: readJsonFile<StoredWorkspaceConfig>("workspace.json"),
    channels: readJsonFile<StoredChannelsConfig>("channels.json"),
    tools: readJsonFile<StoredToolsConfig>("tools.json"),
    agents: readJsonFile<StoredAgentsConfig>("agents.json"),
    agentCards: readJsonFile<StoredAgentCardsConfig>("agent-cards.json"),
    memory: readJsonFile<StoredMemoryConfig>("memory.json"),
  };
}

export function saveConfigBundle(bundle: MalikrawConfigBundle): void {
  ensureConfigDirectory();
  if (bundle.system) {
    writeJsonFile("system.json", bundle.system);
  }
  if (bundle.providers) {
    writeJsonFile("providers.json", bundle.providers);
  }
  if (bundle.agentProviderMapping) {
    writeJsonFile("agent-provider-mapping.json", bundle.agentProviderMapping);
  }
  if (bundle.workspace) {
    writeJsonFile("workspace.json", bundle.workspace);
  }
  if (bundle.channels) {
    writeJsonFile("channels.json", bundle.channels);
  }
  if (bundle.tools) {
    writeJsonFile("tools.json", bundle.tools);
  }
  if (bundle.agents) {
    writeJsonFile("agents.json", bundle.agents);
  }
  if (bundle.agentCards) {
    writeJsonFile("agent-cards.json", bundle.agentCards);
  }
  if (bundle.memory) {
    writeJsonFile("memory.json", bundle.memory);
  }
}

function getConfigFilePath(fileName: string): string {
  return path.join(getConfigDirectory(), fileName);
}

function readJsonFile<T>(fileName: string): T | undefined {
  const filePath = getConfigFilePath(fileName);
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function writeJsonFile(fileName: string, value: unknown): void {
  const filePath = getConfigFilePath(fileName);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
