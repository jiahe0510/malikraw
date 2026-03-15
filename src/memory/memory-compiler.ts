import type { RetrievedMemory, SessionTaskState } from "./types.js";

export function compileRelevantMemoryBlock(
  input: Omit<RetrievedMemory, "compiledBlock">,
  maxChars: number,
): string {
  const lines: string[] = ["[Relevant Memory]"];

  const memoryItems = input.memoryItems
    .map((item) => `- Query: ${truncate(item.query, 80)} | Memory: ${truncate(item.content, 160)}`)
    .slice(0, 6);
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
    .slice(-4)
    .map((message) => `- ${message.role}: ${truncate(message.content, 120)}`) ?? [];
  if (recentMessages.length > 0) {
    lines.push("");
    lines.push("Recent session messages:");
    lines.push(...recentMessages);
  }

  if (lines.length === 1) {
    return "";
  }

  return truncate(lines.join("\n"), maxChars).trim();
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
