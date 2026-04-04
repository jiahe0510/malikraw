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
import type { ProviderProfile } from "../core/providers/compatibility-profile.js";
import { getWorkspaceRoot } from "../runtime/workspace-context.js";
import { restartBackgroundService } from "./service-manager.js";
import { promptMultiSelect, promptSelectWithDefault, promptText } from "./terminal-ui.js";

type ChannelSelection = "http" | "feishu";
type ExistingMultiValue = "__use_existing__";
type ProviderSelection = ProviderProfile | "__existing__";
type MultiSelectResult<T extends string> = {
  selectedValues: T[];
  useExisting: boolean;
};

export async function runOnboardWizard(): Promise<void> {
  console.log("malikraw onboard");
  console.log("");

  const existing = loadConfigBundle();
  const existingProvider = getExistingProvider(existing);
  const provider = await collectProvider(existingProvider);
  const workspaceRoot = getWorkspaceRoot();

  const agents = collectAgents(provider.id);
  const defaultAgentId = agents[0]?.id ?? "main";
  const channels = await collectChannels(existing.channels?.channels ?? [], defaultAgentId, agents.map((agent) => agent.id));
  const tools = await collectToolsConfig(existing.tools);
  const memory = await collectMemoryConfig(existing.memory);
  const gatewayPort = await promptRequiredNumber(
    "Gateway port",
    String(existing.system?.gatewayPort ?? 5050),
  );
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
    defaultProviderId: provider.id,
    providers: [compactProviderConfig(provider)],
  };
  const agentProviderMapping: StoredAgentProviderMappingConfig = {
    defaultProviderId: provider.id,
    mappings: Object.fromEntries(agents.map((agent) => [agent.id, agent.providerId ?? provider.id])),
  };
  const workspace: StoredWorkspaceConfig = {
    workspaceRoot,
  };
  const storedChannels: StoredChannelsConfig = {
    defaultChannelId: resolveDefaultChannelId(channels),
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

  console.log("");
  console.log("Configuration saved.");
  console.log(`Workspace root: ${workspaceRoot}`);

  if (startNow === "yes") {
    loadRuntimeConfig();
    const status = restartBackgroundService();
    console.log("Service restarted.");
    console.log(`pid: ${status.running ? status.pid : "unknown"}`);
  }
}

async function collectProvider(existingProvider: StoredProviderConfig | undefined): Promise<StoredProviderConfig> {
  const defaultProfile: ProviderProfile = existingProvider?.profile ?? "openai";
  const selectedProfile = await promptSelectWithDefault<ProviderSelection>(
    "Choose a provider profile",
    [
      { label: "OpenAI-compatible", value: "openai" },
      { label: "DeepSeek-compatible", value: "deepseek" },
      { label: "Qwen-compatible", value: "qwen" },
      ...(existingProvider ? [{
        label: `Use existing provider (${formatProviderSummary(existingProvider)})`,
        value: "__existing__" as const,
      }] : []),
    ],
    existingProvider ? "__existing__" : defaultProfile,
  );

  if (selectedProfile === "__existing__" && existingProvider) {
    return existingProvider;
  }

  const profile: ProviderProfile = selectedProfile === "__existing__"
    ? defaultProfile
    : (selectedProfile as ProviderProfile);

  return compactProviderConfig({
    id: await promptText("Provider id", existingProvider?.id || "default"),
    baseURL: await promptText(
      "Provider base URL",
      existingProvider?.baseURL || defaultBaseUrlForProfile(profile),
    ),
    apiKey: await promptText("Provider API key", existingProvider?.apiKey || "dummy"),
    model: await promptText("Model name", existingProvider?.model || defaultModelForProfile(profile)),
    profile,
    temperature: await promptOptionalNumber(
      "Temperature",
      String(existingProvider?.temperature ?? 0.2),
    ) ?? 0.2,
    contextWindow: await promptRequiredNumber(
      "Context window",
      String(existingProvider?.contextWindow ?? 32768),
    ),
    maxTokens: await promptRequiredNumber(
      "Max output tokens",
      String(existingProvider?.maxTokens ?? 4096),
    ),
  });
}

function collectAgents(
  providerId: string,
): StoredAgentConfig[] {
  return [{
    id: "main",
    activeSkillIds: [],
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
  const { selectedValues: selectedChannels, useExisting } = await promptMultiSelectOrUseExisting<ChannelSelection>(
    "Select channels",
    [
      { label: "feishu", value: "feishu" },
      { label: "http", value: "http" },
    ],
    [],
    existingChannels,
    existingChannels.map((channel) => channel.type as ChannelSelection),
    existingChannels.length > 0
      ? `Use existing channels (${formatChannelsSummary(existingChannels)})`
      : undefined,
  );

  if (useExisting) {
    return existingChannels;
  }

  const channels: StoredChannelConfig[] = [];

  if (selectedChannels.includes("feishu")) {
    channels.push(await collectFeishuChannel(existingFeishu, defaultAgentId, agentIds));
  }

  if (selectedChannels.includes("http")) {
    const agentId = await promptSelectWithDefault(
      "HTTP channel agent",
      agentIds.map((value) => ({
        label: value,
        value,
      })),
      existingHttp?.agentId || defaultAgentId,
    );
    channels.push({
      id: await promptText("HTTP channel id", existingHttp?.id || "http"),
      type: "http",
      agentId,
    });
  }

  return channels;
}

async function collectFeishuChannel(
  existingChannel: StoredFeishuChannelConfig | undefined,
  defaultAgentId: string,
  agentIds: string[],
): Promise<StoredFeishuChannelConfig> {
  const replyMode = await promptSelectWithDefault(
    "Feishu reply mode",
    [
      { label: "Send to chat", value: "chat" },
      { label: "Reply to message", value: "reply" },
      { label: "Reply in thread", value: "thread" },
    ],
    existingChannel?.replyMode ?? (existingChannel?.autoReplyInThread ? "thread" : "chat"),
  );
  const messageFormat = await promptSelectWithDefault(
    "Feishu message format",
    [
      { label: "Markdown card", value: "interactive" },
      { label: "Plain text", value: "text" },
    ],
    existingChannel?.messageFormat ?? "interactive",
  );
  const agentId = await promptSelectWithDefault(
    "Feishu channel agent",
    agentIds.map((value) => ({
      label: value,
      value,
    })),
    existingChannel?.agentId || defaultAgentId,
  );

  return {
    ...(existingChannel ?? {}),
    id: await promptText("Feishu channel id", existingChannel?.id || "feishu"),
    type: "feishu",
    appId: await promptText("Feishu app id", existingChannel?.appId || ""),
    appSecret: await promptText("Feishu app secret", existingChannel?.appSecret || ""),
    agentId,
    replyMode,
    messageFormat,
  };
}

export function resolveDefaultChannelId(channels: StoredChannelConfig[]): string {
  return channels.find((channel) => channel.type === "feishu")?.id
    ?? channels[0]?.id
    ?? "";
}

async function collectToolsConfig(existingTools: StoredToolsConfig | undefined): Promise<StoredToolsConfig> {
  const { selectedValues: selectedTools, useExisting } = await promptMultiSelectOrUseExisting(
    "Select tools",
    [{ label: "web_search", value: "web_search" }],
    [],
    existingTools,
    existingTools?.braveSearchApiKey ? ["web_search"] : [],
    existingTools
      ? `Use existing tools (${formatToolsSummary(existingTools)})`
      : undefined,
  );

  if (useExisting && existingTools) {
    return existingTools;
  }

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
  _existingMemory: StoredMemoryConfig | undefined,
): Promise<StoredMemoryConfig> {
  return {};
}

function compactProviderConfig(provider: StoredProviderConfig): StoredProviderConfig {
  return {
    ...provider,
    temperature: provider.temperature,
    contextWindow: provider.contextWindow,
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

async function promptMultiSelectOrUseExisting<T extends string>(
  question: string,
  options: Array<{ label: string; value: T }>,
  defaultValues: readonly T[],
  existingMarker: unknown,
  existingValues: readonly T[] = defaultValues,
  existingLabel?: string,
): Promise<MultiSelectResult<T>> {
  const choices = hasExistingSelection(existingMarker, existingValues)
    ? [...options, {
      label: existingLabel ?? "Skip and use existing",
      value: "__use_existing__" as ExistingMultiValue,
    }]
    : options;
  const selected = await promptMultiSelect<T | ExistingMultiValue>(question, choices, defaultValues);

  if (selected.includes("__use_existing__")) {
    return {
      selectedValues: [...existingValues],
      useExisting: true,
    };
  }

  return {
    selectedValues: selected.filter((value): value is T => value !== "__use_existing__"),
    useExisting: false,
  };
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

function hasExistingSelection(existingMarker: unknown, existingValues: readonly string[]): boolean {
  if (existingValues.length > 0) {
    return true;
  }

  if (Array.isArray(existingMarker)) {
    return existingMarker.length > 0;
  }

  return Boolean(existingMarker);
}

export function maskSecret(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "(empty)";
  }

  if (trimmed.length <= 6) {
    return `${trimmed[0] ?? ""}***${trimmed.at(-1) ?? ""}`;
  }

  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

export function formatProviderSummary(provider: StoredProviderConfig): string {
  return [
    provider.profile ?? "openai",
    provider.model,
    simplifyUrl(provider.baseURL),
    `key=${maskSecret(provider.apiKey)}`,
  ].join(" | ");
}

export function formatChannelsSummary(channels: StoredChannelConfig[]): string {
  if (channels.length === 0) {
    return "none";
  }

  return channels
    .map((channel) => {
      if (channel.type === "feishu") {
        return `feishu:${channel.id} agent=${channel.agentId}`;
      }

      return `${channel.type}:${channel.id} agent=${channel.agentId}`;
    })
    .join(", ");
}

export function formatToolsSummary(tools: StoredToolsConfig | undefined): string {
  const enabled: string[] = [];
  if (tools?.braveSearchApiKey) {
    enabled.push(`web_search key=${maskSecret(tools.braveSearchApiKey)}`);
  }

  return enabled.length > 0 ? enabled.join(", ") : "none";
}

function simplifyUrl(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}
