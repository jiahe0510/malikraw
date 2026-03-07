import { loadRuntimeConfig } from "../core/config/agent-config.js";
import {
  loadConfigBundle,
  type StoredAgentConfig,
  type StoredAgentProviderMappingConfig,
  type StoredAgentsConfig,
  type StoredChannelConfig,
  type StoredChannelsConfig,
  type StoredFeishuChannelConfig,
  type StoredProviderConfig,
  type StoredProvidersConfig,
  type StoredSystemConfig,
  type StoredToolsConfig,
  type StoredWorkspaceConfig,
  saveConfigBundle,
} from "../core/config/config-store.js";
import { startBackgroundService } from "./service-manager.js";
import { installBundledSkills, listBundledSkillIds } from "../runtime/bundled-skills.js";
import { getWorkspaceRoot } from "../runtime/workspace-context.js";
import { promptMultiSelect, promptSelectWithDefault, promptText } from "./terminal-ui.js";

type AgentMode = "single" | "multi";
type YesNo = "yes" | "no";

export async function runOnboardWizard(): Promise<void> {
  console.log("malikraw onboard");
  console.log("");

  const existing = loadConfigBundle();
  const existingProvider = getExistingProvider(existing);
  const existingAgents = existing.agents?.agents ?? [];
  const existingDefaultAgent = existing.agents?.defaultAgentId
    ? existingAgents.find((agent) => agent.id === existing.agents?.defaultAgentId) ?? existingAgents[0]
    : existingAgents[0];
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
  const temperature = await promptOptionalNumber(
    "Temperature",
    existingProvider?.temperature !== undefined ? String(existingProvider.temperature) : "0.2",
  );
  const maxTokens = await promptOptionalNumber(
    "Max tokens",
    existingProvider?.maxTokens !== undefined ? String(existingProvider.maxTokens) : "",
  );

  const gatewayPort = await promptRequiredNumber(
    "Gateway port",
    String(existing.system?.gatewayPort ?? 5050),
  );
  const workspaceRoot = await promptText(
    "Workspace path",
    existing.workspace?.workspaceRoot || getWorkspaceRoot(),
  );
  const maxIterations = await promptRequiredNumber(
    "Max iterations",
    String(existing.system?.maxIterations ?? 8),
  );
  const debugModelMessages = await promptSelectWithDefault("Enable model message debug logging?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ], existing.system?.debugModelMessages ? "yes" : "no");
  const agentMode = await promptSelectWithDefault("Agent mode", [
    { label: "Single agent", value: "single" },
    { label: "Multi agent", value: "multi" },
  ], existingAgents.length > 1 ? "multi" : "single");

  const availableSkillIds = await listBundledSkillIds();
  const agents = await collectAgents(agentMode, providerId, availableSkillIds, existingAgents);
  const defaultAgentId = agents[0]?.id ?? "primary";
  const channels = await collectChannels(existing.channels?.channels ?? [], defaultAgentId, agents.map((agent) => agent.id));
  const tools = await collectToolsConfig(existing.tools);
  const startNow = await promptSelectWithDefault("Start service now?", [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ], "no");

  const system: StoredSystemConfig = {
    gatewayPort,
    maxIterations,
    debugModelMessages: debugModelMessages === "yes",
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
      temperature,
      maxTokens,
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
    defaultChannelId: channels[0]?.id ?? "http",
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
    const status = startBackgroundService();
    console.log("Service started.");
    console.log(`pid: ${status.running ? status.pid : "unknown"}`);
  }
}

async function collectAgents(
  agentMode: AgentMode,
  providerId: string,
  availableSkillIds: string[],
  existingAgents: StoredAgentConfig[],
): Promise<StoredAgentConfig[]> {
  if (agentMode === "single") {
    const existingAgent = existingAgents[0];
    const agentId = await promptText("Agent id", existingAgent?.id || "primary");
    const activeSkills = await selectSkillsForAgent(
      availableSkillIds,
      existingAgent?.activeSkillIds ?? ["workspace_operator"],
    );
    return [{
      id: agentId,
      activeSkillIds: activeSkills,
      providerId,
    }];
  }

  const agentCount = await promptRequiredNumber(
    "How many agents?",
    String(existingAgents.length > 1 ? existingAgents.length : 2),
  );
  const agents: StoredAgentConfig[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    console.log("");
    console.log(`Agent ${index + 1}`);
    const existingAgent = existingAgents[index];
    const fallbackId = index === 0 ? "planner" : index === 1 ? "executor" : `agent-${index + 1}`;
    const agentId = await promptText("Agent id", existingAgent?.id || fallbackId);
    const activeSkills = await selectSkillsForAgent(
      availableSkillIds,
      existingAgent?.activeSkillIds ?? ["workspace_operator"],
    );
    agents.push({
      id: agentId,
      activeSkillIds: activeSkills,
      providerId,
    });
  }

  return agents;
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
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ], existingHttp ? "yes" : "yes");

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

  if (channels.length > 0) {
    return channels;
  }

  return [{ id: "http", type: "http" }];
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
  const agentId = await promptSelectWithDefault("Feishu channel agent", agentIds.map((value) => ({
    label: value,
    value,
  })), existingChannel?.agentId || defaultAgentId);

  return {
    id: await promptText("Feishu channel id", existingChannel?.id || "feishu"),
    type: "feishu",
    appId: await promptText("Feishu app id", existingChannel?.appId || ""),
    appSecret: await promptText("Feishu app secret", existingChannel?.appSecret || ""),
    agentId,
    verificationToken: emptyToUndefined(
      await promptText("Feishu verification token", existingChannel?.verificationToken || ""),
    ),
    encryptKey: emptyToUndefined(
      await promptText("Feishu encrypt key", existingChannel?.encryptKey || ""),
    ),
    replyMode,
  };
}

async function collectToolsConfig(existingTools: StoredToolsConfig | undefined): Promise<StoredToolsConfig> {
  const configureBrave = await promptSelectWithDefault("Configure Brave web_search key?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ], existingTools?.braveSearchApiKey ? "yes" : "no");

  if (configureBrave === "no") {
    return {
      braveSearchApiKey: existingTools?.braveSearchApiKey,
    };
  }

  return {
    braveSearchApiKey: emptyToUndefined(
      await promptText("Brave Search API key", existingTools?.braveSearchApiKey || ""),
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

  return defaultSkillIds.filter((skillId) => availableSkillIds.includes(skillId));
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
