import { loadRuntimeConfig } from "../core/config/agent-config.js";
import {
  loadConfigBundle,
  type StoredAgentConfig,
  type StoredAgentProviderMappingConfig,
  type StoredAgentsConfig,
  type StoredChannelConfig,
  type StoredChannelsConfig,
  type StoredFeishuChannelConfig,
  type StoredMemoryConfig,
  type StoredProviderConfig,
  type StoredProvidersConfig,
  type StoredSystemConfig,
  type StoredToolsConfig,
  type StoredWorkspaceConfig,
  saveConfigBundle,
} from "../core/config/config-store.js";
import { getServiceStatus, restartBackgroundService, startBackgroundService } from "./service-manager.js";
import { installBundledSkills, listBundledSkillIds } from "../runtime/bundled-skills.js";
import { getWorkspaceRoot } from "../runtime/workspace-context.js";
import { promptMultiSelect, promptSelectWithDefault, promptText } from "./terminal-ui.js";

type YesNo = "yes" | "no";

export async function runOnboardWizard(): Promise<void> {
  console.log("malikraw onboard");
  console.log("");

  const existing = loadConfigBundle();
  const existingProvider = getExistingProvider(existing);
  const existingAgents = existing.agents?.agents ?? [];
  const defaultProfile = existingProvider?.profile ?? "openai";

  const profile = await promptSelectWithDefault("Choose a provider profile", [
    { label: "OpenAI-compatible", value: "openai" },
    { label: "DeepSeek-compatible", value: "deepseek" },
    { label: "Qwen-compatible", value: "qwen" },
  ], defaultProfile);

  const providerId = await promptText("Provider id", existingProvider?.id || "default");
  const baseURL = await promptText(
    "Provider base URL",
    existingProvider?.baseURL || defaultBaseUrlForProfile(profile),
  );
  const apiKey = await promptText("Provider API key", existingProvider?.apiKey || "dummy");
  const model = await promptText("Model name", existingProvider?.model || defaultModelForProfile(profile));

  const gatewayPort = await promptRequiredNumber(
    "Gateway port",
    String(existing.system?.gatewayPort ?? 5050),
  );
  const workspaceRoot = getWorkspaceRoot();

  const availableSkillIds = await listBundledSkillIds();
  const agents = await collectAgents(providerId, availableSkillIds, existingAgents);
  const defaultAgentId = agents[0]?.id ?? "main";
  const channels = await collectChannels(existing.channels?.channels ?? [], defaultAgentId, agents.map((agent) => agent.id));
  const tools = await collectToolsConfig(existing.tools);
  const memory = await collectMemoryConfig(existing.memory, model);
  const startNow = await promptSelectWithDefault("Start service now?", [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ], "no");

  const system: StoredSystemConfig = {
    gatewayPort,
    debugModelMessages: false,
    globalPolicy: "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
  };
  const providers: StoredProvidersConfig = {
    defaultProviderId: providerId,
    providers: [compactProviderConfig({
      id: providerId,
      baseURL,
      apiKey,
      model,
      profile,
      temperature: 0.2,
      maxTokens: 4096,
    })],
  };
  const agentProviderMapping: StoredAgentProviderMappingConfig = {
    defaultProviderId: providerId,
    mappings: Object.fromEntries(agents.map((agent) => [agent.id, agent.providerId ?? providerId])),
  };
  const workspace: StoredWorkspaceConfig = {
    workspaceRoot,
  };
  const storedChannels: StoredChannelsConfig = {
    defaultChannelId: channels[0]?.id ?? "",
    channels,
  };
  const storedAgents: StoredAgentsConfig = {
    defaultAgentId,
    agents,
  };

  saveConfigBundle({
    system,
    providers,
    agentProviderMapping,
    workspace,
    channels: storedChannels,
    tools,
    agents: storedAgents,
    memory,
  });

  await installBundledSkills(
    [...new Set(agents.flatMap((agent) => agent.activeSkillIds))],
    workspaceRoot,
  );

  console.log("");
  console.log("Configuration saved.");
  console.log(`Installed skills into ${workspaceRoot}/skills`);

  if (startNow === "yes") {
    loadRuntimeConfig();
    const wasRunning = getServiceStatus().running;
    const status = wasRunning
      ? restartBackgroundService()
      : startBackgroundService();
    console.log(wasRunning ? "Service restarted." : "Service started.");
    console.log(`pid: ${status.running ? status.pid : "unknown"}`);
  }
}

async function collectAgents(
  providerId: string,
  availableSkillIds: string[],
  existingAgents: StoredAgentConfig[],
): Promise<StoredAgentConfig[]> {
  const existingAgent = existingAgents.find((agent) => agent.id === "main") ?? existingAgents[0];
  const activeSkills = await selectSkillsForAgent(
    availableSkillIds,
    existingAgent?.activeSkillIds ?? [],
  );
  return [{
    id: "main",
    activeSkillIds: activeSkills,
    providerId,
  }];
}

async function collectChannels(
  existingChannels: StoredChannelConfig[],
  defaultAgentId: string,
  agentIds: string[],
): Promise<StoredChannelConfig[]> {
  const existingHttp = existingChannels.find((channel): channel is Extract<StoredChannelConfig, { type: "http" }> =>
    channel.type === "http"
  );
  const existingFeishu = existingChannels.find(
    (channel): channel is StoredFeishuChannelConfig => channel.type === "feishu",
  );

  const enableHttp = await promptSelectWithDefault("Enable HTTP channel?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ], existingHttp ? "yes" : "no");

  const enableFeishu = await promptSelectWithDefault("Enable Feishu channel?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ], existingFeishu ? "yes" : "no");

  const channels: StoredChannelConfig[] = [];
  if (enableHttp === "yes") {
    const httpAgentId = await promptSelectWithDefault("HTTP channel agent", agentIds.map((agentId) => ({
      label: agentId,
      value: agentId,
    })), existingHttp?.agentId || defaultAgentId);
    channels.push({
      id: await promptText("HTTP channel id", existingHttp?.id || "http"),
      type: "http",
      agentId: httpAgentId,
    });
  }

  if (enableFeishu === "yes") {
    channels.push(await collectFeishuChannel(existingFeishu, defaultAgentId, agentIds));
  }

  return channels;
}

async function collectFeishuChannel(
  existingChannel: StoredFeishuChannelConfig | undefined,
  defaultAgentId: string,
  agentIds: string[],
): Promise<StoredFeishuChannelConfig> {
  const replyMode = await promptSelectWithDefault("Feishu reply mode", [
    { label: "Send to chat", value: "chat" },
    { label: "Reply to message", value: "reply" },
    { label: "Reply in thread", value: "thread" },
  ], existingChannel?.replyMode ?? (existingChannel?.autoReplyInThread ? "thread" : "chat"));
  const messageFormat = await promptSelectWithDefault("Feishu message format", [
    { label: "Markdown card", value: "interactive" },
    { label: "Plain text", value: "text" },
  ], existingChannel?.messageFormat ?? "interactive");
  const agentId = await promptSelectWithDefault("Feishu channel agent", agentIds.map((value) => ({
      label: value,
      value,
    })), existingChannel?.agentId || defaultAgentId);

  return {
    id: await promptText("Feishu channel id", existingChannel?.id || "飞书"),
    type: "feishu",
    appId: await promptText("Feishu app id", existingChannel?.appId || ""),
    appSecret: await promptText("Feishu app secret", existingChannel?.appSecret || ""),
    agentId,
    replyMode,
    messageFormat,
  };
}

async function collectToolsConfig(existingTools: StoredToolsConfig | undefined): Promise<StoredToolsConfig> {
  const selectedTools = await promptMultiSelect(
    "Select tools",
    [{
      label: "web_search",
      value: "web_search",
    }],
    existingTools?.braveSearchApiKey ? ["web_search"] : [],
  );

  if (!selectedTools.includes("web_search")) {
    return {
      braveSearchApiKey: undefined,
    };
  }

  return {
    braveSearchApiKey: emptyToUndefined(
      await promptText("Brave Search API key", existingTools?.braveSearchApiKey || ""),
    ),
  };
}

async function collectMemoryConfig(
  existingMemory: StoredMemoryConfig | undefined,
  defaultEmbeddingModel: string,
): Promise<StoredMemoryConfig> {
  const enableMemory = await promptSelectWithDefault("Enable Enhanced memory?", [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ], existingMemory?.enabled ? "yes" : "no");

  if (enableMemory === "no") {
    return {
      enabled: false,
      postgresUrl: existingMemory?.postgresUrl,
      redisUrl: existingMemory?.redisUrl,
      embeddingModel: existingMemory?.embeddingModel,
      embeddingDimensions: existingMemory?.embeddingDimensions,
      sessionRecentMessages: existingMemory?.sessionRecentMessages,
      semanticTopK: existingMemory?.semanticTopK,
      episodicTopK: existingMemory?.episodicTopK,
      maxPromptChars: existingMemory?.maxPromptChars,
      importanceThreshold: existingMemory?.importanceThreshold,
    };
  }

  return {
    enabled: true,
    postgresUrl: emptyToUndefined(
      await promptText("Enhanced memory Postgres URL", existingMemory?.postgresUrl || "postgres://localhost:5432/malikraw"),
    ),
    redisUrl: emptyToUndefined(
      await promptText("Enhanced memory Redis URL", existingMemory?.redisUrl || "redis://127.0.0.1:6379"),
    ),
    embeddingModel: emptyToUndefined(
      await promptText("Enhanced memory embedding model", existingMemory?.embeddingModel || defaultEmbeddingModel),
    ),
    embeddingDimensions: await promptRequiredNumber(
      "Embedding dimensions",
      String(existingMemory?.embeddingDimensions ?? 1536),
    ),
    sessionRecentMessages: await promptRequiredNumber(
      "Session recent messages",
      String(existingMemory?.sessionRecentMessages ?? 8),
    ),
    semanticTopK: await promptRequiredNumber(
      "Semantic memory top-k",
      String(existingMemory?.semanticTopK ?? 6),
    ),
    episodicTopK: await promptRequiredNumber(
      "Episodic memory top-k",
      String(existingMemory?.episodicTopK ?? 4),
    ),
    maxPromptChars: await promptRequiredNumber(
      "Memory prompt char budget",
      String(existingMemory?.maxPromptChars ?? 2000),
    ),
    importanceThreshold: await promptOptionalNumber(
      "Enhanced memory importance threshold",
      existingMemory?.importanceThreshold !== undefined ? String(existingMemory.importanceThreshold) : "0.65",
    ),
  };
}

function compactProviderConfig(provider: StoredProviderConfig): StoredProviderConfig {
  return {
    ...provider,
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
  };
}

async function promptOptionalNumber(question: string, defaultValue: string): Promise<number | undefined> {
  while (true) {
    const raw = await promptText(question, defaultValue);
    if (!raw) {
      return undefined;
    }

    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    console.error(`Expected a number, received "${raw}".`);
  }
}

async function promptRequiredNumber(question: string, defaultValue: string): Promise<number> {
  while (true) {
    const raw = await promptText(question, defaultValue);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    console.error(`Expected a number, received "${raw}".`);
  }
}

async function selectSkillsForAgent(
  availableSkillIds: string[],
  defaultSkillIds: string[],
): Promise<string[]> {
  if (availableSkillIds.length === 0) {
    return [];
  }

  const selected = await promptMultiSelect(
    "Select skills for this agent",
    availableSkillIds.map((skillId) => ({
      label: skillId,
      value: skillId,
    })),
    defaultSkillIds,
  );

  if (selected.length > 0) {
    return selected;
  }

  return [];
}

function defaultBaseUrlForProfile(profile: StoredProviderConfig["profile"]): string {
  if (profile === "deepseek") {
    return "https://api.deepseek.com";
  }
  if (profile === "qwen") {
    return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  }

  return "https://api.openai.com/v1";
}

function defaultModelForProfile(profile: StoredProviderConfig["profile"]): string {
  if (profile === "deepseek") {
    return "deepseek-chat";
  }
  if (profile === "qwen") {
    return "qwen-plus";
  }

  return "gpt-4.1-mini";
}

function emptyToUndefined(value: string): string | undefined {
  return value.trim() || undefined;
}

function getExistingProvider(
  existing: ReturnType<typeof loadConfigBundle>,
): StoredProviderConfig | undefined {
  const defaultProviderId = existing.providers?.defaultProviderId;
  return existing.providers?.providers.find((provider) => provider.id === defaultProviderId)
    ?? existing.providers?.providers[0];
}
