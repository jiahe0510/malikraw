import {
  ManualSkillRouter,
  OpenAICompatibleModel,
  SkillRegistry,
  ToolRegistry,
  loadSkillsFromDirectory,
  registerBuiltinTools,
  runAgentLoop,
} from "../index.js";
import type { RuntimeConfig } from "../core/config/agent-config.js";
import type { AgentMessage } from "../core/agent/types.js";
import { readBundledPersonalityFile } from "./system-template-context.js";
import {
  ensureWorkspaceInitialized,
  getSkillsDirectory,
  getWorkspaceRoot,
  readWorkspaceAgentFile,
  readWorkspaceIdentityFile,
  readWorkspacePersonalityFile,
  setWorkspaceRoot,
} from "./workspace-context.js";

export type AgentRuntime = {
  workspaceRoot: string;
  ask(input: {
    userRequest: string;
    history?: AgentMessage[];
  }): Promise<{
    output: string;
    visibleToolNames: string[];
    messages: AgentMessage[];
  }>;
};

export async function createAgentRuntime(config: RuntimeConfig): Promise<AgentRuntime> {
  setWorkspaceRoot(config.workspaceRoot);
  await ensureWorkspaceInitialized();

  const toolRegistry = registerBuiltinTools(new ToolRegistry());
  const skillRegistry = new SkillRegistry();
  const skills = await loadSkillsFromDirectory(getSkillsDirectory());
  for (const skill of skills) {
    skillRegistry.register(skill);
  }

  const model = new OpenAICompatibleModel(config.model);

  return {
    workspaceRoot: getWorkspaceRoot(),
    ask: async ({ userRequest, history }) => {
      const identitySystemContent = await readWorkspaceIdentityFile();
      const personalitySystemContent = await readWorkspacePersonalityFile()
        ?? await readBundledPersonalityFile();
      const agentSystemContent = await readWorkspaceAgentFile();
      const result = await runAgentLoop({
        model,
        toolRegistry,
        skillRegistry,
        skillRouter: new ManualSkillRouter(config.activeSkillIds),
        globalPolicy: config.globalPolicy,
        identitySystemContent,
        personalitySystemContent,
        agentSystemContent,
        userRequest,
        history,
        stateSummary: config.stateSummary,
        memorySummary: config.memorySummary,
        maxIterations: config.maxIterations,
        debugModelMessages: config.debugModelMessages,
      });

      return {
        output: result.finalOutput,
        visibleToolNames: result.visibleToolNames,
        messages: result.messages,
      };
    },
  };
}
