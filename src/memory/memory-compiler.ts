import { getMessageText } from "../core/agent/message-content.js";
import type { AgentMessage } from "../core/agent/types.js";
import type { RetrievedMemory, SessionTaskState } from "./types.js";

const MIN_MEMORY_PROMPT_CHARS = 600;
const MAX_MEMORY_PROMPT_CHARS = 6000;

export function compileRelevantMemoryBlock(
  input: Omit<RetrievedMemory, "compiledBlock">,
  options: {
    query: string;
    contextWindow: number;
    maxTokens: number;
  },
): string {
  const maxChars = deriveMemoryPromptBudget(options);
  const lines: string[] = ["[Relevant Memory]"];

  const memoryItems = input.memoryItems
    .map((item) => `- Query: ${truncate(item.query, 80)} | Memory: ${truncate(item.content, 160)}`)
    .slice(0, 4);
  if (memoryItems.length > 0) {
    lines.push("");
    lines.push("Relevant user memory:");
    lines.push(...memoryItems);
  }

  const toolChainHints = input.toolChains
    .slice(0, 3)
    .map((item) => {
      const chain = item.toolChain.map((step) => step.toolName).join(" -> ");
      return `- Query: ${truncate(item.query, 100)} | Tools: ${truncate(chain, 120)}`;
    });
  if (toolChainHints.length > 0) {
    lines.push("");
    lines.push("Reusable tool chains:");
    lines.push(...toolChainHints);
  }

  const taskStateBlock = formatTaskState(input.sessionState?.state.taskState);
  if (taskStateBlock.length > 0) {
    lines.push("");
    lines.push("Current task state:");
    lines.push(...taskStateBlock);
  }

  const recentMessages = input.sessionState?.state.recentMessages
    ?? [];
  const dynamicRecentMessages = fitRecentMessagesWithinBudget(recentMessages, lines, maxChars);
  if (dynamicRecentMessages.length > 0) {
    lines.push("");
    lines.push("Recent session messages:");
    lines.push(...dynamicRecentMessages);
  }

  if (lines.length === 1) {
    return "";
  }

  return truncate(lines.join("\n"), maxChars).trim();
}

function deriveMemoryPromptBudget(input: {
  query: string;
  contextWindow: number;
  maxTokens: number;
}): number {
  const inputBudgetTokens = Math.max(512, input.contextWindow - input.maxTokens - 2048);
  const baseChars = Math.floor(inputBudgetTokens * 4 * 0.2);
  const queryPenalty = Math.min(1200, input.query.length * 2);
  return Math.max(MIN_MEMORY_PROMPT_CHARS, Math.min(MAX_MEMORY_PROMPT_CHARS, baseChars - queryPenalty));
}

function fitRecentMessagesWithinBudget(
  recentMessages: AgentMessage[],
  currentLines: string[],
  maxChars: number,
): string[] {
  if (recentMessages.length === 0) {
    return [];
  }

  const selected: string[] = [];
  const baseLength = currentLines.join("\n").length + "\n\nRecent session messages:\n".length;

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const line = `- ${recentMessages[index]?.role}: ${truncate(getMessageText(recentMessages[index]!), 120)}`;
    const candidate = [line, ...selected];
    const candidateLength = baseLength + candidate.join("\n").length;
    if (candidateLength > maxChars) {
      break;
    }
    selected.unshift(line);
  }

  return selected;
}

function formatTaskState(taskState: SessionTaskState | undefined): string[] {
  if (!taskState) {
    return [];
  }

  const lines = [
    taskState.goal ? `- Goal: ${taskState.goal}` : undefined,
    taskState.currentPlan.length > 0 ? `- Current plan: ${taskState.currentPlan.join("; ")}` : undefined,
    taskState.completedSteps.length > 0 ? `- Completed: ${taskState.completedSteps.join("; ")}` : undefined,
    taskState.openQuestions.length > 0 ? `- Open questions: ${taskState.openQuestions.join("; ")}` : undefined,
    `- Status: ${taskState.status}`,
  ];

  return lines.filter((line): line is string => Boolean(line));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
