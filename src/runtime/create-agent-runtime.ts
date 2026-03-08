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
import { createMemoryService } from "../memory/memory-service.js";
import { runMemoryMigrations } from "../memory/migrate.js";
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
    sessionId?: string;
    userId?: string;
    agentId?: string;
    channelId?: string;
    projectId?: string;
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
  if (config.memory?.enabled && config.memory.postgresUrl) {
    await runMemoryMigrations(config.memory.postgresUrl, config.memory.embeddingDimensions);
  }

  const toolRegistry = registerBuiltinTools(new ToolRegistry());
  const skillRegistry = new SkillRegistry();
  const skills = await loadSkillsFromDirectory(getSkillsDirectory());
  for (const skill of skills) {
    skillRegistry.register(skill);
  }

  const model = new OpenAICompatibleModel(config.model);
  const memoryService = createMemoryService(config.memory, config.model);

  return {
    workspaceRoot: getWorkspaceRoot(),
    ask: async ({ userRequest, history, sessionId, userId, agentId, channelId, projectId }) => {
      const identitySystemContent = await readWorkspaceIdentityFile();
      const personalitySystemContent = await readWorkspacePersonalityFile()
        ?? await readBundledPersonalityFile();
      const agentSystemContent = await readWorkspaceAgentFile();
      const memorySystemContent = await readWorkspaceMemoryFile();
      const resolvedAgentId = agentId ?? "default";
      const resolvedUserId = userId ?? sessionId ?? "anonymous";
      const resolvedSessionId = sessionId ?? "default";
      const resolvedProjectId = projectId ?? getWorkspaceRoot();
      const retrievedMemory = await memoryService.retrieve({
        context: {
          sessionId: resolvedSessionId,
          userId: resolvedUserId,
          agentId: resolvedAgentId,
          channelId,
          projectId: resolvedProjectId,
        },
        query: userRequest,
      });
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
        relevantMemoryBlock: retrievedMemory.compiledBlock,
        maxIterations: config.maxIterations,
        debugModelMessages: config.debugModelMessages,
      });

      await memoryService.write({
        context: {
          sessionId: resolvedSessionId,
          userId: resolvedUserId,
          agentId: resolvedAgentId,
          channelId,
          projectId: resolvedProjectId,
        },
        userMessage: userRequest,
        assistantResponse: result.finalOutput,
        toolResults: result.toolResults,
        sessionMessages: result.messages.filter((message) =>
          message.role === "user" || message.role === "assistant"
        ),
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
