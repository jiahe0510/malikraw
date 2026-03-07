import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProviderProfile } from "../providers/compatibility-profile.js";

export type StoredSystemConfig = {
  gatewayPort: number;
  globalPolicy?: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations: number;
  debugModelMessages: boolean;
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
  autoReplyInThread?: boolean;
};

export type StoredChannelConfig = StoredHttpChannelConfig | StoredFeishuChannelConfig;

export type StoredChannelsConfig = {
  defaultChannelId: string;
  channels: StoredChannelConfig[];
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

export type MalikrawConfigBundle = {
  system?: StoredSystemConfig;
  providers?: StoredProvidersConfig;
  agentProviderMapping?: StoredAgentProviderMappingConfig;
  workspace?: StoredWorkspaceConfig;
  channels?: StoredChannelsConfig;
  agents?: StoredAgentsConfig;
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
    agents: readJsonFile<StoredAgentsConfig>("agents.json"),
  };
}

export function saveConfigBundle(bundle: Required<MalikrawConfigBundle>): void {
  ensureConfigDirectory();
  writeJsonFile("system.json", bundle.system);
  writeJsonFile("providers.json", bundle.providers);
  writeJsonFile("agent-provider-mapping.json", bundle.agentProviderMapping);
  writeJsonFile("workspace.json", bundle.workspace);
  writeJsonFile("channels.json", bundle.channels);
  writeJsonFile("agents.json", bundle.agents);
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
