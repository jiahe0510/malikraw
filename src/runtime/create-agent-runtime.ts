import {
  OpenAICompatibleModel,
  SkillRegistry,
  ToolRegistry,
  createMemorySearchTool,
  createReadFeishuDocTool,
  createUpdateFeishuDocTool,
  loadSkillsFromDirectory,
  registerBuiltinTools,
  runAgentLoop,
  runAgentLoopEvents,
  ManualSkillRouter,
} from "../index.js";
import type { RuntimeConfig } from "../core/config/agent-config.js";
import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import type { AgentLoopEvent, AgentMessage } from "../core/agent/types.js";
import { createMemoryService } from "../memory/memory-service.js";
import { runMemoryMigrations } from "../memory/migrate.js";
import { compactContextIfNeeded, reactivelyCompactMessages } from "./context-compactor.js";
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
  askEvents?(input: {
    userRequest: string;
    history?: AgentMessage[];
    sessionId?: string;
    userId?: string;
    agentId?: string;
    channelId?: string;
    projectId?: string;
  }): AsyncGenerator<AgentLoopEvent, {
    output: string;
    visibleToolNames: string[];
    messages: AgentMessage[];
    media: ChannelMedia[];
    messageDispatches: MessageDispatch[];
  }, void>;
};

type RuntimeDependencies = {
  skillRegistry: SkillRegistry;
  model: OpenAICompatibleModel;
  memoryService: ReturnType<typeof createMemoryService>;
};

type RuntimeAskInput = Parameters<AgentRuntime["ask"]>[0];

type RuntimePromptContent = {
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  compactInstructionContent?: string;
};

type RuntimeTurnExecution = {
  result: Awaited<ReturnType<typeof runAgentLoop>>;
  compaction: Awaited<ReturnType<typeof compactContextIfNeeded>>;
  memoryContext: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId?: string;
    projectId?: string;
  };
};

export async function createAgentRuntime(config: RuntimeConfig): Promise<AgentRuntime> {
  const dependencies = await bootstrapRuntimeDependencies(config);
  const askEvents: NonNullable<AgentRuntime["askEvents"]> = async function* (input) {
    const execution = yield* executeRuntimeTurnEvents(config, dependencies, input);
    await persistRuntimeTurn(dependencies.memoryService, input.userRequest, execution);
    return buildRuntimeAskResponse(execution.result);
  };
  const ask: AgentRuntime["ask"] = async (input) => {
    const stream = askEvents(input);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        return next.value;
      }
    }
  };

  return {
    workspaceRoot: getWorkspaceRoot(),
    ask,
    askEvents,
  };
}

async function bootstrapRuntimeDependencies(config: RuntimeConfig): Promise<RuntimeDependencies> {
  setWorkspaceRoot(config.workspaceRoot);
  await ensureWorkspaceInitialized();
  if (config.memory?.enabled) {
    await runMemoryMigrations();
  }

  const skillRegistry = new SkillRegistry();
  const skills = await loadSkillsFromDirectory(getSkillsDirectory());
  for (const skill of skills) {
    skillRegistry.register(skill);
  }

  return {
    skillRegistry,
    model: new OpenAICompatibleModel(config.model),
    memoryService: createMemoryService(config.memory, config.model),
  };
}

async function* executeRuntimeTurnEvents(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
  input: RuntimeAskInput,
): AsyncGenerator<AgentLoopEvent, RuntimeTurnExecution, void> {
  const promptContent = await loadRuntimePromptContent();
  const memoryContext = resolveMemoryContext(input);
  const toolRegistry = createRuntimeToolRegistry({
    channels: config.channels,
    channelId: input.channelId,
    memoryEnabled: Boolean(config.memory?.enabled),
    memoryService: dependencies.memoryService,
    memoryContext,
  });
  const compaction = await compactContextIfNeeded({
    model: dependencies.model,
    modelConfig: config.model,
    compactInstructionContent: promptContent.compactInstructionContent,
    globalPolicy: config.globalPolicy,
    identitySystemContent: promptContent.identitySystemContent,
    personalitySystemContent: promptContent.personalitySystemContent,
    agentSystemContent: promptContent.agentSystemContent,
    memorySystemContent: promptContent.memorySystemContent,
    history: input.history,
    userRequest: input.userRequest,
  });
  const stream = runAgentLoopEvents({
    model: dependencies.model,
    toolRegistry,
    skillRegistry: dependencies.skillRegistry,
    skillRouter: new ManualSkillRouter(config.activeSkillIds),
    globalPolicy: config.globalPolicy,
    identitySystemContent: promptContent.identitySystemContent,
    personalitySystemContent: promptContent.personalitySystemContent,
    agentSystemContent: promptContent.agentSystemContent,
    memorySystemContent: promptContent.memorySystemContent,
    userRequest: input.userRequest,
    history: compaction.history,
    stateSummary: config.stateSummary,
    memorySummary: config.memorySummary,
    userContext: {
      "Current Date": new Date().toISOString().slice(0, 10),
    },
    systemContext: {
      Channel: input.channelId ?? "local",
      Session: memoryContext.sessionId,
      Project: memoryContext.projectId ?? getWorkspaceRoot(),
    },
    maxIterations: config.maxIterations,
    debugModelMessages: config.debugModelMessages,
    reactiveCompact: ({ messages }) => {
      const compacted = reactivelyCompactMessages({
        modelConfig: config.model,
        messages,
      });
      return compacted.triggered ? compacted.messages : undefined;
    },
  });
  let result: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
  while (true) {
    const next = await stream.next();
    if (next.done) {
      result = {
        ...next.value,
        events: [],
      };
      break;
    }
    yield next.value;
  }

  return {
    result: result!,
    compaction,
    memoryContext,
  };
}

async function loadRuntimePromptContent(): Promise<RuntimePromptContent> {
  return {
    identitySystemContent: await readWorkspaceIdentityFile(),
    personalitySystemContent: await readWorkspacePersonalityFile()
      ?? await readBundledPersonalityFile(),
    agentSystemContent: await readWorkspaceAgentFile(),
    memorySystemContent: await readWorkspaceMemoryFile(),
    compactInstructionContent: await readWorkspaceCompactFile(),
  };
}

function resolveMemoryContext(input: RuntimeAskInput): RuntimeTurnExecution["memoryContext"] {
  const resolvedAgentId = input.agentId ?? "default";
  const resolvedUserId = input.userId ?? input.sessionId ?? "anonymous";
  const resolvedSessionId = input.sessionId ?? "default";
  const resolvedProjectId = input.projectId ?? getWorkspaceRoot();

  return {
    sessionId: resolvedSessionId,
    userId: resolvedUserId,
    agentId: resolvedAgentId,
    channelId: input.channelId,
    projectId: resolvedProjectId,
  };
}

async function persistRuntimeTurn(
  memoryService: ReturnType<typeof createMemoryService>,
  userRequest: string,
  execution: RuntimeTurnExecution,
): Promise<void> {
  await memoryService.write({
    context: execution.memoryContext,
    userMessage: userRequest,
    assistantResponse: execution.result.finalOutput,
    toolResults: execution.result.toolResults,
    sessionMessages: execution.result.messages.filter((message) =>
      message.role === "user" || message.role === "assistant"
    ),
    compaction: execution.compaction.summary
      ? {
        summary: execution.compaction.summary,
        messagesCompacted: execution.compaction.messagesCompacted,
        estimatedTokens: execution.compaction.estimatedTokens.history,
      }
      : undefined,
  });
}

function buildRuntimeAskResponse(result: Awaited<ReturnType<typeof runAgentLoop>>): Awaited<ReturnType<AgentRuntime["ask"]>> {
  return {
    output: result.finalOutput,
    visibleToolNames: result.visibleToolNames,
    messages: result.messages,
    media: extractMedia(result.toolResults),
    messageDispatches: extractMessageDispatches(result.toolResults),
  };
}

function createRuntimeToolRegistry(input: {
  channels: RuntimeConfig["channels"];
  channelId?: string;
  memoryEnabled: boolean;
  memoryService: ReturnType<typeof createMemoryService>;
  memoryContext: {
    sessionId: string;
    userId: string;
    agentId: string;
    channelId?: string;
    projectId?: string;
  };
}): ToolRegistry {
  const registry = registerBuiltinTools(new ToolRegistry());
  if (input.memoryEnabled) {
    registry.register(createMemorySearchTool(input.memoryService, input.memoryContext));
  }
  const feishuChannel = resolveFeishuChannelConfig(input.channels, input.channelId);
  if (feishuChannel) {
    registry.register(createReadFeishuDocTool(feishuChannel));
    registry.register(createUpdateFeishuDocTool(feishuChannel));
  }
  return registry;
}

function resolveFeishuChannelConfig(
  channels: RuntimeConfig["channels"],
  channelId?: string,
): StoredFeishuChannelConfig | undefined {
  if (channelId) {
    const exact = channels.find((channel): channel is StoredFeishuChannelConfig =>
      channel.type === "feishu" && channel.id === channelId);
    if (exact) {
      return exact;
    }
  }

  return channels.find((channel): channel is StoredFeishuChannelConfig => channel.type === "feishu");
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
