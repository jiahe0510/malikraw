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
  readWorkspaceMemoryFile,
  readWorkspacePersonalityFile,
  setWorkspaceRoot,
} from "./workspace-context.js";
import type { ToolResultEnvelope } from "../core/tool-registry/types.js";

export type AgentRuntime = {
  workspaceRoot: string;
  ask(input: {
    userRequest: string;
    history?: AgentMessage[];
  }): Promise<{
    output: string;
    visibleToolNames: string[];
    messages: AgentMessage[];
    attachmentPaths: string[];
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
      const memorySystemContent = await readWorkspaceMemoryFile();
      const result = await runAgentLoop({
        model,
        toolRegistry,
        skillRegistry,
        skillRouter: new ManualSkillRouter(config.activeSkillIds),
        globalPolicy: config.globalPolicy,
        identitySystemContent,
        personalitySystemContent,
        agentSystemContent,
        memorySystemContent,
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
        attachmentPaths: extractAttachmentPaths(result.toolResults),
      };
    },
  };
}

function extractAttachmentPaths(toolResults: ToolResultEnvelope[]): string[] {
  const paths = new Set<string>();

  for (const result of toolResults) {
    if (!result.ok) {
      continue;
    }

    for (const pathValue of collectPathCandidates(result.data)) {
      if (looksLikeSendableAttachment(pathValue)) {
        paths.add(pathValue);
      }
    }
  }

  return [...paths];
}

function collectPathCandidates(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];

  if (typeof record.path === "string") {
    paths.push(record.path);
  }
  if (typeof record.filePath === "string") {
    paths.push(record.filePath);
  }
  if (typeof record.outputPath === "string") {
    paths.push(record.outputPath);
  }

  return paths;
}

function looksLikeSendableAttachment(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".tiff",
    ".bmp",
    ".ico",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".ppt",
    ".pptx",
    ".mp4",
    ".mp3",
    ".wav",
    ".m4a",
    ".opus",
    ".zip",
    ".txt",
    ".md",
    ".json",
  ].some((extension) => normalized.endsWith(extension));
}
