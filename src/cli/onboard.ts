import { loadRuntimeConfig } from "../core/config/agent-config.js";
import {
  type StoredAgentConfig,
  type StoredAgentProviderMappingConfig,
  type StoredAgentsConfig,
  type StoredProviderConfig,
  type StoredProvidersConfig,
  type StoredSystemConfig,
  type StoredWorkspaceConfig,
  saveConfigBundle,
} from "../core/config/config-store.js";
import { startBackgroundService } from "./service-manager.js";
import { getWorkspaceRoot } from "../runtime/workspace-context.js";
import { promptSelect, promptText } from "./terminal-ui.js";

type AgentMode = "single" | "multi";
type YesNo = "yes" | "no";

export async function runOnboardWizard(): Promise<void> {
  console.log("malikraw onboard");
  console.log("");

  const profile = await promptSelect("Choose a provider profile", [
    { label: "OpenAI-compatible", value: "openai" },
    { label: "DeepSeek-compatible", value: "deepseek" },
    { label: "Qwen-compatible", value: "qwen" },
  ]);

  const providerId = await promptText("Provider id", "default");
  const baseURL = await promptText("Provider base URL", defaultBaseUrlForProfile(profile));
  const apiKey = await promptText("Provider API key", "dummy");
  const model = await promptText("Model name", defaultModelForProfile(profile));
  const temperature = await promptOptionalNumber("Temperature", "0.2");
  const maxTokens = await promptOptionalNumber("Max tokens", "");

  const gatewayPort = await promptRequiredNumber("Gateway port", "5050");
  const workspaceRoot = await promptText("Workspace path", getWorkspaceRoot());
  const maxIterations = await promptRequiredNumber("Max iterations", "8");
  const debugModelMessages = await promptSelect("Enable model message debug logging?", [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ]);

  const agentMode = await promptSelect("Agent mode", [
    { label: "Single agent", value: "single" },
    { label: "Multi agent", value: "multi" },
  ]);

  const agents = await collectAgents(agentMode, providerId);
  const defaultAgentId = agents[0]?.id ?? "primary";
  const startNow = await promptSelect("Start service now?", [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ]);

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
  const storedAgents: StoredAgentsConfig = {
    defaultAgentId,
    agents,
  };

  saveConfigBundle({
    system,
    providers,
    agentProviderMapping,
    workspace,
    agents: storedAgents,
  });

  console.log("");
  console.log("Configuration saved.");

  if (startNow === "yes") {
    loadRuntimeConfig(process.env);
    const status = startBackgroundService();
    console.log("Service started.");
    console.log(`pid: ${status.running ? status.pid : "unknown"}`);
  }
}

async function collectAgents(agentMode: AgentMode, providerId: string): Promise<StoredAgentConfig[]> {
  if (agentMode === "single") {
    const agentId = await promptText("Agent id", "primary");
    const activeSkills = await promptText("Active skills (comma-separated)", "workspace_operator");
    return [{
      id: agentId,
      activeSkillIds: splitCsv(activeSkills) || ["workspace_operator"],
      providerId,
    }];
  }

  const agentCount = await promptRequiredNumber("How many agents?", "2");
  const agents: StoredAgentConfig[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    console.log("");
    console.log(`Agent ${index + 1}`);
    const fallbackId = index === 0 ? "planner" : index === 1 ? "executor" : `agent-${index + 1}`;
    const agentId = await promptText("Agent id", fallbackId);
    const activeSkills = await promptText("Active skills (comma-separated)", "workspace_operator");
    agents.push({
      id: agentId,
      activeSkillIds: splitCsv(activeSkills) || ["workspace_operator"],
      providerId,
    });
  }

  return agents;
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

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
