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
import { compactContextIfNeeded } from "./context-compactor.js";
import { readBundledPersonalityFile } from "./system-template-context.js";
import type { MessageDispatch } from "../channels/channel.js";
import {
  ensureWorkspaceInitialized,
  getSkillsDirectory,
  getWorkspaceRoot,
  readWorkspaceAgentFile,
  readWorkspaceCompactFile,
  readWorkspaceIdentityFile,
  readWorkspaceMemoryFile,
  readWorkspacePersonalityFile,
  setWorkspaceRoot,
} from "./workspace-context.js";
import type { ToolResultEnvelope } from "../core/tool-registry/types.js";
import type { ChannelMedia } from "../channels/channel.js";

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
    media: ChannelMedia[];
    messageDispatches: MessageDispatch[];
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
      const compactInstructionContent = await readWorkspaceCompactFile();
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
      const compaction = await compactContextIfNeeded({
        model,
        modelConfig: config.model,
        compactInstructionContent,
        globalPolicy: config.globalPolicy,
        identitySystemContent,
        personalitySystemContent,
        agentSystemContent,
        memorySystemContent,
        history,
        userRequest,
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
        history: compaction.history,
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
        compaction: compaction.summary
          ? {
            summary: compaction.summary,
            messagesCompacted: compaction.messagesCompacted,
            estimatedTokens: compaction.estimatedTokens.history,
          }
          : undefined,
      });

      return {
        output: result.finalOutput,
        visibleToolNames: result.visibleToolNames,
        messages: result.messages,
        media: extractMedia(result.toolResults),
        messageDispatches: extractMessageDispatches(result.toolResults),
      };
    },
  };
}

function extractMessageDispatches(toolResults: ToolResultEnvelope[]): MessageDispatch[] {
  const dispatches: MessageDispatch[] = [];

  for (const result of toolResults) {
    if (!result.ok || result.toolName !== "message") {
      continue;
    }

    const dispatch = normalizeMessageDispatch(result.data);
    if (dispatch) {
      dispatches.push(dispatch);
    }
  }

  return dispatches;
}

function normalizeMessageDispatch(value: unknown): MessageDispatch | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : "";
  const media = Array.isArray(record.media)
    ? record.media
      .map((item) => normalizeDispatchedMedia(item))
      .filter((item): item is ChannelMedia => item !== undefined)
    : undefined;
  const session = normalizeDispatchSession(record.session);

  if (!content.trim() && (!media || media.length === 0)) {
    return undefined;
  }

  return {
    session,
    content,
    media,
  };
}

function normalizeDispatchedMedia(value: unknown): ChannelMedia | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") {
    return undefined;
  }

  const kind = record.kind === "image" || record.kind === "file"
    ? record.kind
    : inferMediaKindFromPath(record.path);

  return {
    kind,
    path: record.path,
    ...(typeof record.fileName === "string" ? { fileName: record.fileName } : {}),
    ...(typeof record.caption === "string" ? { caption: record.caption } : {}),
  };
}

function normalizeDispatchSession(value: unknown): MessageDispatch["session"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const session = Object.fromEntries(
    Object.entries({
      agentId: record.agentId,
      userId: record.userId,
      projectId: record.projectId,
      channelId: record.channelId,
      sessionId: record.sessionId,
    }).filter(([, fieldValue]) => typeof fieldValue === "string" && fieldValue.trim().length > 0),
  );

  return Object.keys(session).length > 0 ? session : undefined;
}

function extractMedia(toolResults: ToolResultEnvelope[]): ChannelMedia[] {
  const mediaByPath = new Map<string, ChannelMedia>();

  for (const result of toolResults) {
    if (!result.ok) {
      continue;
    }

    for (const media of collectMediaCandidates(result.data)) {
      mediaByPath.set(media.path, media);
    }
  }

  return [...mediaByPath.values()];
}

function collectMediaCandidates(value: unknown): ChannelMedia[] {
  const collected: ChannelMedia[] = [];
  visitMediaCandidate(value, collected);
  return deduplicateMedia(collected);
}

function visitMediaCandidate(value: unknown, collected: ChannelMedia[]): void {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    const media = toMediaFromPath(value);
    if (media) {
      collected.push(media);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitMediaCandidate(item, collected);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["path", "filePath", "outputPath"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const media = toMediaFromPath(candidate, {
        fileName: readString(record.fileName),
        caption: readString(record.caption) ?? readString(record.description) ?? readString(record.title),
      });
      if (media) {
        collected.push(media);
      }
    }
  }

  for (const key of ["paths", "files", "artifacts", "attachments", "images"]) {
    if (key in record) {
      visitMediaCandidate(record[key], collected);
    }
  }

  if (typeof record.type === "string" && typeof record.path === "string") {
    const forcedKind = record.type === "image" || record.type === "file" ? record.type : undefined;
    const media = toMediaFromPath(record.path, {
      kind: forcedKind,
      fileName: readString(record.fileName),
      caption: readString(record.caption) ?? readString(record.description) ?? readString(record.title),
    });
    if (media) {
      collected.push(media);
    }
  }
}

function toMediaFromPath(
  filePath: string,
  options: {
    kind?: "image" | "file";
    fileName?: string;
    caption?: string;
  } = {},
): ChannelMedia | undefined {
  if (!looksLikeSendableAttachment(filePath)) {
    return undefined;
  }

  return {
    kind: options.kind ?? inferMediaKind(filePath),
    path: filePath,
    fileName: options.fileName,
    caption: options.caption,
  };
}

function inferMediaKindFromPath(filePath: string): "image" | "file" {
  return inferMediaKind(filePath);
}

function inferMediaKind(filePath: string): "image" | "file" {
  const normalized = filePath.toLowerCase();
  if ([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".tiff",
    ".bmp",
    ".ico",
  ].some((extension) => normalized.endsWith(extension))) {
    return "image";
  }

  return "file";
}

function deduplicateMedia(mediaItems: ChannelMedia[]): ChannelMedia[] {
  const mediaByPath = new Map<string, ChannelMedia>();
  for (const item of mediaItems) {
    mediaByPath.set(item.path, item);
  }
  return [...mediaByPath.values()];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
