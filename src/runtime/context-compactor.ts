import { readFile } from "node:fs/promises";

import type { AgentMessage, AgentModel } from "../core/agent/types.js";
import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { readCompactTemplateFile } from "./system-template-context.js";

const COMPACTED_HISTORY_PREFIX = "[compacted_history]\n";
const SAFETY_MARGIN_TOKENS = 1024;

export type ContextCompactionInput = {
  model: AgentModel;
  modelConfig: OpenAICompatibleConfig;
  globalPolicy: string;
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  history?: AgentMessage[];
  userRequest: string;
};

export type ContextCompactionResult = {
  history: AgentMessage[];
  summary?: string;
  triggered: boolean;
  messagesCompacted: number;
  estimatedTokens: {
    system: number;
    history: number;
    inputBudget: number;
  };
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
  const inputBudget = Math.max(1024, input.modelConfig.contextWindow - input.modelConfig.maxTokens! - SAFETY_MARGIN_TOKENS);
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

  const splitIndex = findCompactionSplitIndex(history, input.modelConfig.compact.targetTokens);
  if (splitIndex <= 0 || splitIndex >= history.length) {
    return fallbackCompact(history, history, [], systemTokens, historyTokens, inputBudget);
  }

  const olderMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);
  return fallbackCompact(olderMessages, history, recentMessages, systemTokens, historyTokens, inputBudget, input);
}

async function fallbackCompact(
  olderMessages: AgentMessage[],
  history: AgentMessage[],
  recentMessages: AgentMessage[],
  systemTokens: number,
  historyTokens: number,
  inputBudget: number,
  input?: ContextCompactionInput,
): Promise<ContextCompactionResult> {
  const summary = input
    ? await summarizeHistory(input, olderMessages)
    : renderCompactedHistory(olderMessages);

  const compactedMessage: AgentMessage = {
    role: "user",
    content: `${COMPACTED_HISTORY_PREFIX}${summary}`,
  };

  return {
    history: summary.trim() ? [compactedMessage, ...recentMessages] : history,
    summary: summary.trim() || undefined,
    triggered: true,
    messagesCompacted: olderMessages.length,
    estimatedTokens: {
      system: systemTokens,
      history: historyTokens,
      inputBudget,
    },
  };
}

async function summarizeHistory(input: ContextCompactionInput, messages: AgentMessage[]): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const guidance = await loadCompactionInstruction(input.modelConfig.compact.instructionPath);
  const renderedHistory = renderCompactedHistory(messages);

  try {
    const response = await input.model.generate({
      messages: [{
        role: "system",
        content: guidance,
      }, {
        role: "user",
        content: [
          `Upcoming user request: ${input.userRequest}`,
          "",
          "Conversation history to compress:",
          renderedHistory,
        ].join("\n"),
      }],
      tools: [],
    });

    if (response.type === "final" && response.outputText.trim()) {
      return truncate(response.outputText.trim(), 4000);
    }
  } catch {
    return renderCompactedHistory(messages);
  }

  return renderCompactedHistory(messages);
}

async function loadCompactionInstruction(configuredPath: string | undefined): Promise<string> {
  if (configuredPath?.trim()) {
    const content = await readFile(configuredPath.trim(), "utf8");
    return content.trim();
  }

  return (await readCompactTemplateFile())?.trim()
    || "Compress prior conversation history into a concise, loss-aware summary.";
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

function alignToUserBoundary(history: AgentMessage[], index: number): number {
  for (let cursor = index; cursor < history.length; cursor += 1) {
    if (history[cursor]?.role === "user") {
      return cursor;
    }
  }

  return Math.min(index, history.length - 1);
}

function renderCompactedHistory(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `tool ${message.toolName ?? "unknown"}: ${truncate(message.content, 400)}`;
      }

      return `${message.role}: ${truncate(message.content, 400)}`;
    })
    .join("\n");
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(`${message.role}:${message.content}`);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
