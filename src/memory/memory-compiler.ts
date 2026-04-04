import type { RetrievedMemory } from "./types.js";

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

  const sessionHandoff = input.sessionState?.state.handoff ?? [];
  if (sessionHandoff.length > 0) {
    lines.push("");
    lines.push("Session handoff:");
    lines.push(...sessionHandoff.map((entry) => `- ${truncate(entry, 220)}`));
  }

  const sessionNotes = input.sessionState?.state.notes ?? [];
  const dynamicSessionNotes = fitLinesWithinBudget(
    sessionNotes.map((entry) => `- ${truncate(entry, 220)}`),
    lines,
    maxChars,
  );
  if (dynamicSessionNotes.length > 0) {
    lines.push("");
    lines.push("Remembered session notes:");
    lines.push(...dynamicSessionNotes);
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

function fitLinesWithinBudget(
  candidates: string[],
  currentLines: string[],
  maxChars: number,
): string[] {
  if (candidates.length === 0) {
    return [];
  }

  const selected: string[] = [];
  const baseLength = currentLines.join("\n").length + "\n\nSession additions:\n".length;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = candidates[index] ?? "";
    const candidate = [line, ...selected];
    const candidateLength = baseLength + candidate.join("\n").length;
    if (candidateLength > maxChars) {
      break;
    }
    selected.unshift(line);
  }

  return selected;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
