import { readFile } from "node:fs/promises";

import type { AgentMessage, AgentModel } from "../core/agent/types.js";
import { createTextMessage, getMessageText } from "../core/agent/message-content.js";
import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import { readCompactTemplateFile } from "./system-template-context.js";

const COMPACTED_HISTORY_PREFIX = "[compacted_history]\n";
const COMPACTED_TOOL_RESULT_PREFIX = "[compacted_tool_result]";
const SAFETY_MARGIN_TOKENS = 1024;
const MICRO_TOOL_RESULT_MAX_CHARS = 240;
const LONG_TEXT_MESSAGE_MAX_CHARS = 700;

export type ContextCompactionStrategy = "micro" | "session" | "summary" | "reactive";

export type ContextCompactionInput = {
  model: AgentModel;
  modelConfig: OpenAICompatibleConfig;
  compactInstructionContent?: string;
  globalPolicy: string;
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  history?: AgentMessage[];
  userRequest: string;
};

export type ReactiveCompactionInput = {
  modelConfig: OpenAICompatibleConfig;
  messages: AgentMessage[];
};

export type ContextCompactionResult = {
  history: AgentMessage[];
  summary?: string;
  triggered: boolean;
  strategy?: ContextCompactionStrategy;
  messagesCompacted: number;
  estimatedTokens: {
    system: number;
    history: number;
    inputBudget: number;
  };
};

export type ReactiveCompactionResult = {
  messages: AgentMessage[];
  triggered: boolean;
  strategy?: ContextCompactionStrategy;
  messagesCompacted: number;
};

export async function compactContextIfNeeded(input: ContextCompactionInput): Promise<ContextCompactionResult> {
  const history = input.history ?? [];
  const systemTokens = estimateTokens([
    input.globalPolicy,
    input.identitySystemContent,
    input.personalitySystemContent,
    input.agentSystemContent,
    input.memorySystemContent,
  ].filter(Boolean).join("\n\n"));
  const historyTokens = estimateMessagesTokens(history);
  const inputBudget = Math.max(
    1024,
    input.modelConfig.contextWindow - input.modelConfig.maxTokens! - SAFETY_MARGIN_TOKENS,
  );
  const thresholdTokens = Math.min(input.modelConfig.compact.thresholdTokens, inputBudget);

  if (history.length === 0 || systemTokens + historyTokens <= thresholdTokens) {
    return {
      history,
      triggered: false,
      messagesCompacted: 0,
      estimatedTokens: {
        system: systemTokens,
        history: historyTokens,
        inputBudget,
      },
    };
  }

  const result = await compactHistoryLayers({
    history,
    model: input.model,
    modelConfig: input.modelConfig,
    compactInstructionContent: input.compactInstructionContent,
    userRequest: input.userRequest,
    systemTokens,
    historyTokens,
    inputBudget,
    thresholdTokens,
    allowModelSummary: true,
    force: false,
    strategyOnSuccess: undefined,
  });
  if (result.triggered) {
    recordCompactionResult("context.compact", input.userRequest, result, {
      systemTokens,
      historyTokens,
      inputBudget,
      thresholdTokens,
    });
  }
  return result;
}

export function reactivelyCompactMessages(input: ReactiveCompactionInput): ReactiveCompactionResult {
  const prefixLength = findInstructionPrefixLength(input.messages);
  const instructionMessages = input.messages.slice(0, prefixLength);
  const conversationMessages = input.messages.slice(prefixLength);
  if (conversationMessages.length === 0) {
    return {
      messages: input.messages,
      triggered: false,
      messagesCompacted: 0,
    };
  }

  const systemTokens = estimateMessagesTokens(instructionMessages);
  const historyTokens = estimateMessagesTokens(conversationMessages);
  const inputBudget = Math.max(
    1024,
    input.modelConfig.contextWindow - input.modelConfig.maxTokens! - SAFETY_MARGIN_TOKENS,
  );

  const compacted = compactHistoryLayersSync({
    history: conversationMessages,
    userRequest: findLastUserMessage(conversationMessages) ?? "",
    modelConfig: input.modelConfig,
    systemTokens,
    historyTokens,
    inputBudget,
    thresholdTokens: Math.min(input.modelConfig.compact.thresholdTokens, inputBudget),
    force: true,
  });

  if (!compacted.triggered) {
    return {
      messages: input.messages,
      triggered: false,
      messagesCompacted: 0,
    };
  }

  const result: ReactiveCompactionResult = {
    messages: [...instructionMessages, ...compacted.history],
    triggered: true,
    strategy: "reactive",
    messagesCompacted: compacted.messagesCompacted,
  };
  recordCompactionResult(
    "context.compact.reactive",
    findLastUserMessage(conversationMessages) ?? "",
    {
      ...compacted,
      strategy: "reactive",
    },
    {
      systemTokens,
      historyTokens,
      inputBudget,
      thresholdTokens: Math.min(input.modelConfig.compact.thresholdTokens, inputBudget),
    },
  );
  return result;
}

async function compactHistoryLayers(input: {
  history: AgentMessage[];
  model: AgentModel;
  modelConfig: OpenAICompatibleConfig;
  compactInstructionContent?: string;
  userRequest: string;
  systemTokens: number;
  historyTokens: number;
  inputBudget: number;
  thresholdTokens: number;
  allowModelSummary: boolean;
  force: boolean;
  strategyOnSuccess?: ContextCompactionStrategy;
}): Promise<ContextCompactionResult> {
  const micro = microCompactHistory(input.history);
  if (micro.changed) {
    recordRuntimeObservation({
      name: "context.compact.micro",
      message: "Applied micro compaction to older messages.",
      data: {
        messagesCompacted: micro.messagesCompacted,
        historyMessages: input.history.length,
        userRequest: truncate(input.userRequest, 180),
      },
    });
  }
  const microTokens = estimateMessagesTokens(micro.history);
  if (micro.changed && !input.force && input.systemTokens + microTokens <= input.thresholdTokens) {
    return {
      history: micro.history,
      summary: undefined,
      triggered: true,
      strategy: "micro",
      messagesCompacted: micro.messagesCompacted,
      estimatedTokens: {
        system: input.systemTokens,
        history: input.historyTokens,
        inputBudget: input.inputBudget,
      },
    };
  }

  const sessionCompact = buildSessionCompactHistory(
    micro.history,
    input.userRequest,
    input.modelConfig.compact.targetTokens,
    input.inputBudget - input.systemTokens,
  );
  if (sessionCompact.triggered) {
    recordRuntimeObservation({
      name: "context.compact.session",
      message: "Built structured session compact handoff.",
      data: {
        messagesCompacted: sessionCompact.messagesCompacted,
        olderMessages: sessionCompact.olderMessages.length,
        recentMessages: sessionCompact.recentMessages.length,
        userRequest: truncate(input.userRequest, 180),
      },
    });
  }
  if (sessionCompact.triggered && estimateMessagesTokens(sessionCompact.history) + input.systemTokens <= input.inputBudget) {
    return {
      history: sessionCompact.history,
      summary: sessionCompact.summary,
      triggered: true,
      strategy: input.strategyOnSuccess ?? "session",
      messagesCompacted: sessionCompact.messagesCompacted,
      estimatedTokens: {
        system: input.systemTokens,
        history: input.historyTokens,
        inputBudget: input.inputBudget,
      },
    };
  }

  const summary = input.allowModelSummary
    ? await summarizeHistory(input, sessionCompact.olderMessages, sessionCompact.summary)
    : buildEmergencySummary(sessionCompact.olderMessages, input.userRequest, sessionCompact.summary);
  recordRuntimeObservation({
    name: "context.compact.summary",
    message: "Fell back to summary-based compaction.",
    data: {
      messagesCompacted: sessionCompact.messagesCompacted || micro.messagesCompacted,
      olderMessages: sessionCompact.olderMessages.length,
      recentMessages: sessionCompact.recentMessages.length,
      usedModelSummary: input.allowModelSummary,
      userRequest: truncate(input.userRequest, 180),
    },
  });
  const recentMessages = trimRecentMessagesToFit(
    sessionCompact.recentMessages,
    Math.max(256, input.inputBudget - input.systemTokens - estimateTokens(summary)),
  );
  const compactedMessage: AgentMessage = createTextMessage("user", `${COMPACTED_HISTORY_PREFIX}${summary}`);

  return {
    history: summary.trim() ? [compactedMessage, ...recentMessages] : sessionCompact.history,
    summary: summary.trim() || sessionCompact.summary,
    triggered: sessionCompact.triggered || micro.changed,
    strategy: input.strategyOnSuccess ?? "summary",
    messagesCompacted: sessionCompact.messagesCompacted || micro.messagesCompacted,
    estimatedTokens: {
      system: input.systemTokens,
      history: input.historyTokens,
      inputBudget: input.inputBudget,
    },
  };
}

function compactHistoryLayersSync(input: {
  history: AgentMessage[];
  userRequest: string;
  modelConfig: OpenAICompatibleConfig;
  systemTokens: number;
  historyTokens: number;
  inputBudget: number;
  thresholdTokens: number;
  force: boolean;
}): ContextCompactionResult {
  const micro = microCompactHistory(input.history);
  if (micro.changed) {
    recordRuntimeObservation({
      name: "context.compact.micro",
      message: "Applied micro compaction to older messages.",
      data: {
        messagesCompacted: micro.messagesCompacted,
        historyMessages: input.history.length,
        userRequest: truncate(input.userRequest, 180),
      },
    });
  }
  const microTokens = estimateMessagesTokens(micro.history);
  if (micro.changed && !input.force && input.systemTokens + microTokens <= input.thresholdTokens) {
    return {
      history: micro.history,
      summary: undefined,
      triggered: true,
      strategy: "micro",
      messagesCompacted: micro.messagesCompacted,
      estimatedTokens: {
        system: input.systemTokens,
        history: input.historyTokens,
        inputBudget: input.inputBudget,
      },
    };
  }

  const sessionCompact = buildSessionCompactHistory(
    micro.history,
    input.userRequest,
    input.modelConfig.compact.targetTokens,
    input.inputBudget - input.systemTokens,
  );
  if (sessionCompact.triggered) {
    recordRuntimeObservation({
      name: "context.compact.session",
      message: "Built structured session compact handoff.",
      data: {
        messagesCompacted: sessionCompact.messagesCompacted,
        olderMessages: sessionCompact.olderMessages.length,
        recentMessages: sessionCompact.recentMessages.length,
        userRequest: truncate(input.userRequest, 180),
      },
    });
  }
  if (sessionCompact.triggered && estimateMessagesTokens(sessionCompact.history) + input.systemTokens <= input.inputBudget) {
    return {
      history: sessionCompact.history,
      summary: sessionCompact.summary,
      triggered: true,
      strategy: "session",
      messagesCompacted: sessionCompact.messagesCompacted,
      estimatedTokens: {
        system: input.systemTokens,
        history: input.historyTokens,
        inputBudget: input.inputBudget,
      },
    };
  }

  const summary = buildEmergencySummary(sessionCompact.olderMessages, input.userRequest, sessionCompact.summary);
  recordRuntimeObservation({
    name: "context.compact.summary",
    message: "Fell back to summary-based compaction.",
    data: {
      messagesCompacted: sessionCompact.messagesCompacted || micro.messagesCompacted,
      olderMessages: sessionCompact.olderMessages.length,
      recentMessages: sessionCompact.recentMessages.length,
      usedModelSummary: false,
      userRequest: truncate(input.userRequest, 180),
    },
  });
  const recentMessages = trimRecentMessagesToFit(
    sessionCompact.recentMessages,
    Math.max(256, input.inputBudget - input.systemTokens - estimateTokens(summary)),
  );
  const compactedMessage: AgentMessage = createTextMessage("user", `${COMPACTED_HISTORY_PREFIX}${summary}`);

  return {
    history: summary.trim() ? [compactedMessage, ...recentMessages] : sessionCompact.history,
    summary: summary.trim() || sessionCompact.summary,
    triggered: sessionCompact.triggered || micro.changed,
    strategy: "summary",
    messagesCompacted: sessionCompact.messagesCompacted || micro.messagesCompacted,
    estimatedTokens: {
      system: input.systemTokens,
      history: input.historyTokens,
      inputBudget: input.inputBudget,
    },
  };
}

async function summarizeHistory(
  input: {
    history: AgentMessage[];
    model: AgentModel;
    modelConfig: OpenAICompatibleConfig;
    compactInstructionContent?: string;
    userRequest: string;
  },
  messages: AgentMessage[],
  structuredSummary?: string,
): Promise<string> {
  if (messages.length === 0) {
    return structuredSummary ?? "";
  }

  const guidance = await loadCompactionInstruction(
    input.compactInstructionContent,
    input.modelConfig.compact.instructionPath,
  );
  const renderedHistory = renderCompactedHistory(messages);

  try {
    const response = await input.model.generate({
      messages: [
        createTextMessage("system", guidance),
        createTextMessage("user", [
          `Upcoming user request: ${input.userRequest}`,
          "",
          structuredSummary?.trim()
            ? `Structured session handoff:\n${structuredSummary.trim()}`
            : undefined,
          structuredSummary?.trim() ? "" : undefined,
          "Conversation history to compress:",
          truncate(renderedHistory, 6000),
        ].filter(Boolean).join("\n")),
      ],
      tools: [],
    });

    if (response.type === "final" && response.outputText.trim()) {
      return truncate(response.outputText.trim(), 4000);
    }
  } catch {
    return buildEmergencySummary(messages, input.userRequest, structuredSummary);
  }

  return buildEmergencySummary(messages, input.userRequest, structuredSummary);
}

async function loadCompactionInstruction(
  inlineContent: string | undefined,
  configuredPath: string | undefined,
): Promise<string> {
  if (inlineContent?.trim()) {
    return inlineContent.trim();
  }

  if (configuredPath?.trim()) {
    const content = await readFile(configuredPath.trim(), "utf8");
    return content.trim();
  }

  return (await readCompactTemplateFile())?.trim()
    || "Compress prior conversation history into a concise, loss-aware summary.";
}

function buildSessionCompactHistory(
  history: AgentMessage[],
  userRequest: string,
  targetTokens: number,
  availableTokens: number,
): {
  history: AgentMessage[];
  summary?: string;
  olderMessages: AgentMessage[];
  recentMessages: AgentMessage[];
  triggered: boolean;
  messagesCompacted: number;
} {
  if (history.length === 0) {
    return {
      history,
      olderMessages: [],
      recentMessages: [],
      triggered: false,
      messagesCompacted: 0,
    };
  }

  const splitIndex = findCompactionSplitIndex(history, targetTokens);
  if (splitIndex <= 0 || splitIndex >= history.length) {
    return buildWholeHistoryCompact(history, userRequest, availableTokens);
  }

  const olderMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);
  const summary = buildStructuredSessionSummary(olderMessages, userRequest);
  if (!summary.trim()) {
    return {
      history,
      olderMessages,
      recentMessages,
      triggered: false,
      messagesCompacted: 0,
    };
  }

  const compactedMessage: AgentMessage = createTextMessage("user", `${COMPACTED_HISTORY_PREFIX}${summary}`);
  const trimmedRecentMessages = trimRecentMessagesToFit(
    recentMessages,
    Math.max(256, availableTokens - estimateMessageTokens(compactedMessage)),
  );
  return {
    history: [compactedMessage, ...trimmedRecentMessages],
    summary,
    olderMessages,
    recentMessages: trimmedRecentMessages,
    triggered: true,
    messagesCompacted: olderMessages.length,
  };
}

function buildWholeHistoryCompact(
  history: AgentMessage[],
  userRequest: string,
  availableTokens: number,
): {
  history: AgentMessage[];
  summary?: string;
  olderMessages: AgentMessage[];
  recentMessages: AgentMessage[];
  triggered: boolean;
  messagesCompacted: number;
} {
  const fallbackRecent = trimRecentMessagesToFit(
    history.slice(-Math.min(history.length, 3)),
    Math.max(256, Math.floor(availableTokens * 0.3)),
  );
  const olderCutoff = Math.max(0, history.length - fallbackRecent.length);
  const olderMessages = history.slice(0, olderCutoff);
  const summary = buildStructuredSessionSummary(olderMessages, userRequest);
  if (!summary.trim()) {
    return {
      history,
      olderMessages,
      recentMessages: fallbackRecent,
      triggered: false,
      messagesCompacted: 0,
    };
  }

  return {
    history: [createTextMessage("user", `${COMPACTED_HISTORY_PREFIX}${summary}`), ...fallbackRecent],
    summary,
    olderMessages,
    recentMessages: fallbackRecent,
    triggered: true,
    messagesCompacted: olderMessages.length,
  };
}

function buildStructuredSessionSummary(messages: AgentMessage[], userRequest: string): string {
  if (messages.length === 0) {
    return "";
  }

  const carriedSummaries = messages
    .filter((message) => message.role === "user" && getMessageText(message).startsWith(COMPACTED_HISTORY_PREFIX))
    .map((message) => getMessageText(message).slice(COMPACTED_HISTORY_PREFIX.length).trim())
    .filter(Boolean)
    .slice(-2);
  const userTurns = messages
    .filter((message) => message.role === "user" && !getMessageText(message).startsWith(COMPACTED_HISTORY_PREFIX))
    .map((message) => truncate(cleanInline(getMessageText(message)), 180))
    .filter(Boolean)
    .slice(-4);
  const assistantTurns = messages
    .filter((message) => message.role === "assistant")
    .map((message) => truncate(cleanInline(getMessageText(message)), 180))
    .filter(Boolean)
    .slice(-4);
  const toolSummaries = summarizeToolMessages(messages);
  const references = extractReferences(messages).slice(0, 6);
  const openQuestions = extractQuestions(messages).slice(-3);
  const currentState = assistantTurns.at(-1)
    ?? userTurns.at(-1)
    ?? truncate(userRequest, 180);

  const lines = [
    "Current State",
    `- Active user request: ${truncate(userRequest, 180) || "Continue the prior task."}`,
    `- Latest retained state: ${currentState || "No stable state extracted."}`,
    "",
    "Prior User Turns",
    ...(userTurns.length > 0
      ? userTurns.map((value) => `- ${value}`)
      : ["- No older user turns were preserved."]),
    "",
    "Assistant Outcomes",
    ...(assistantTurns.length > 0
      ? assistantTurns.map((value) => `- ${value}`)
      : ["- No older assistant outcomes were preserved."]),
  ];

  if (toolSummaries.length > 0) {
    lines.push("", "Tool Activity", ...toolSummaries.map((value) => `- ${value}`));
  }

  if (references.length > 0) {
    lines.push("", "Referenced Paths And URLs", ...references.map((value) => `- ${value}`));
  }

  if (openQuestions.length > 0) {
    lines.push("", "Open Questions", ...openQuestions.map((value) => `- ${value}`));
  }

  if (carriedSummaries.length > 0) {
    lines.push("", "Earlier Compacted Context", ...carriedSummaries.map((value) => `- ${truncate(cleanInline(value), 240)}`));
  }

  return truncate(lines.join("\n"), 3200).trim();
}

function buildEmergencySummary(
  messages: AgentMessage[],
  userRequest: string,
  structuredSummary?: string,
): string {
  const recentTranscript = messages
    .slice(-8)
    .map((message) => `${message.role}: ${truncate(cleanInline(getMessageText(message)), 220)}`)
    .join("\n");

  return truncate([
    structuredSummary?.trim(),
    "Emergency Handoff",
    `- Continue handling: ${truncate(userRequest, 180) || "the current request"}`,
    recentTranscript ? "- Recent retained transcript:" : undefined,
    recentTranscript,
  ].filter(Boolean).join("\n"), 3200).trim();
}

function microCompactHistory(history: AgentMessage[]): {
  history: AgentMessage[];
  changed: boolean;
  messagesCompacted: number;
} {
  if (history.length === 0) {
    return { history, changed: false, messagesCompacted: 0 };
  }

  const protectedIndex = findProtectedRecentIndex(history);
  let changed = false;
  let messagesCompacted = 0;
  const compacted = history.map((message, index) => {
    if (index >= protectedIndex) {
      return message;
    }

    const content = getMessageText(message);
    if (message.role === "tool" && content.length > MICRO_TOOL_RESULT_MAX_CHARS) {
      changed = true;
      messagesCompacted += 1;
      return {
        ...createTextMessage(
          message.role,
          `${COMPACTED_TOOL_RESULT_PREFIX} ${message.toolName ?? "unknown"} output omitted (${content.length} chars).`,
          { toolCallId: message.toolCallId, toolName: message.toolName },
        ),
      };
    }

    if ((message.role === "user" || message.role === "assistant") && content.length > LONG_TEXT_MESSAGE_MAX_CHARS) {
      changed = true;
      messagesCompacted += 1;
      return {
        ...createTextMessage(
          message.role,
          truncate(content, LONG_TEXT_MESSAGE_MAX_CHARS),
          { toolCallId: message.toolCallId, toolName: message.toolName },
        ),
      };
    }

    return message;
  });

  return {
    history: compacted,
    changed,
    messagesCompacted,
  };
}

function trimRecentMessagesToFit(messages: AgentMessage[], availableTokens: number): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  if (estimateMessagesTokens(messages) <= availableTokens) {
    return messages;
  }

  let start = alignToUserBoundary(messages, Math.max(0, messages.length - 2));
  while (start < messages.length - 1) {
    const candidate = messages.slice(start);
    if (estimateMessagesTokens(candidate) <= availableTokens) {
      return candidate;
    }

    start = nextUserBoundary(messages, start + 1);
  }

  return messages.slice(-1);
}

function summarizeToolMessages(messages: AgentMessage[]): string[] {
  const summaries = new Map<string, { ok: number; fail: number }>();

  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }

    const toolName = message.toolName ?? "unknown";
    const entry = summaries.get(toolName) ?? { ok: 0, fail: 0 };
    if (/"ok":false/.test(getMessageText(message))) {
      entry.fail += 1;
    } else {
      entry.ok += 1;
    }
    summaries.set(toolName, entry);
  }

  return [...summaries.entries()]
    .slice(0, 6)
    .map(([toolName, counts]) => `${toolName}: ${counts.ok} succeeded, ${counts.fail} failed`);
}

function extractReferences(messages: AgentMessage[]): string[] {
  const references = new Set<string>();
  for (const message of messages) {
    const matches = getMessageText(message).matchAll(/(?:\/[\w./-]+|\bhttps?:\/\/\S+)/g);
    for (const match of matches) {
      const value = match[0]?.trim();
      if (value) {
        references.add(truncate(value, 120));
      }
      if (references.size >= 6) {
        return [...references];
      }
    }
  }

  return [...references];
}

function extractQuestions(messages: AgentMessage[]): string[] {
  const questions: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const matches = getMessageText(message).matchAll(/([^?.!\n]{0,180}\?)/g);
    for (const match of matches) {
      const value = cleanInline(match[1] ?? "");
      if (value) {
        questions.push(value);
      }
    }
  }

  return questions;
}

function findCompactionSplitIndex(history: AgentMessage[], targetTokens: number): number {
  const recentBudget = Math.max(256, Math.floor(targetTokens * 0.35));
  let tokens = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    tokens += estimateMessageTokens(history[index]);
    if (tokens > recentBudget) {
      return alignToUserBoundary(history, index + 1);
    }
  }

  return 0;
}

function findInstructionPrefixLength(messages: AgentMessage[]): number {
  let index = 0;
  while (index < messages.length) {
    const role = messages[index]?.role;
    if (role !== "system" && role !== "developer") {
      break;
    }
    index += 1;
  }
  return index;
}

function findProtectedRecentIndex(history: AgentMessage[]): number {
  let seenUserTurns = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      seenUserTurns += 1;
      if (seenUserTurns >= 1) {
        return index;
      }
    }
  }

  return 0;
}

function alignToUserBoundary(history: AgentMessage[], index: number): number {
  for (let cursor = index; cursor < history.length; cursor += 1) {
    if (history[cursor]?.role === "user") {
      return cursor;
    }
  }

  return Math.min(index, history.length - 1);
}

function nextUserBoundary(history: AgentMessage[], start: number): number {
  for (let index = start; index < history.length; index += 1) {
    if (history[index]?.role === "user") {
      return index;
    }
  }

  return history.length - 1;
}

function findLastUserMessage(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index] ? getMessageText(messages[index]!) : undefined;
    }
  }

  return undefined;
}

function renderCompactedHistory(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `tool ${message.toolName ?? "unknown"}: ${truncate(getMessageText(message), 400)}`;
      }

      return `${message.role}: ${truncate(getMessageText(message), 400)}`;
    })
    .join("\n");
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(`${message.role}:${getMessageText(message)}`);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function recordCompactionResult(
  name: string,
  userRequest: string,
  result: Pick<ContextCompactionResult, "strategy" | "messagesCompacted" | "estimatedTokens">,
  stats: {
    systemTokens: number;
    historyTokens: number;
    inputBudget: number;
    thresholdTokens: number;
  },
): void {
  recordRuntimeObservation({
    name,
    message: "Compaction completed for the current turn.",
    data: {
      strategy: result.strategy ?? "unknown",
      messagesCompacted: result.messagesCompacted,
      systemTokens: stats.systemTokens,
      historyTokens: stats.historyTokens,
      inputBudget: stats.inputBudget,
      thresholdTokens: stats.thresholdTokens,
      userRequest: truncate(userRequest, 180),
    },
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
