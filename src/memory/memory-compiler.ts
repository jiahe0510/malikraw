import type {
  KnowledgeArtifactRecord,
  MemoryRetrieveMode,
  MemoryUsageTier,
  ProceduralArtifactRecord,
  RetrievedMemory,
} from "./types.js";

const MIN_MEMORY_PROMPT_CHARS = 600;
const MAX_MEMORY_PROMPT_CHARS = 6000;

export function compileRelevantMemoryBlock(
  input: Omit<RetrievedMemory, "compiledBlock" | "mode">,
  options: {
    query: string;
    mode: MemoryRetrieveMode;
    contextWindow: number;
    maxTokens: number;
  },
): string {
  const maxChars = deriveMemoryPromptBudget(options);
  const lines: string[] = ["[Relevant Memory]"];

  const factItems = input.knowledgeArtifacts
    .filter((item) => classifyMemoryUsageTier(item, options.mode) === "fact")
    .slice(0, 4);
  if (factItems.length > 0) {
    lines.push("");
    lines.push("Facts:");
    lines.push(...factItems.map(formatFactMemoryLine));
  }

  const patternItems = input.knowledgeArtifacts
    .filter((item) => classifyMemoryUsageTier(item, options.mode) === "pattern")
    .slice(0, 4);
  if (patternItems.length > 0) {
    lines.push("");
    lines.push("Patterns:");
    lines.push(...patternItems.map(formatPatternMemoryLine));
  }

  const hypothesisItems = input.knowledgeArtifacts
    .filter((item) => classifyMemoryUsageTier(item, options.mode) === "hypothesis")
    .slice(0, 3);
  if (hypothesisItems.length > 0) {
    lines.push("");
    lines.push("Hypotheses:");
    lines.push(...hypothesisItems.map(formatHypothesisMemoryLine));
  }

  if (input.proceduralArtifacts.length > 0) {
    lines.push("");
    lines.push("Procedural memory:");
    lines.push(...input.proceduralArtifacts.slice(0, 3).map(formatProceduralMemoryLine));
  }

  const sessionHandoff = input.sessionState?.state.handoff ?? [];
  if (sessionHandoff.length > 0) {
    lines.push("");
    lines.push("STM session snapshot:");
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

function formatFactMemoryLine(item: KnowledgeArtifactRecord): string {
  const subtype = item.memoryType ?? "semantic";
  return `- Fact (${subtype}): ${truncate(item.summary, 120)} | ${truncate(item.content, 150)}`;
}

function formatPatternMemoryLine(item: KnowledgeArtifactRecord): string {
  const label = item.memoryType === "affective" ? "affective" : "symptom";
  return `- Pattern (${label}): ${truncate(item.summary, 120)} | ${truncate(item.content, 140)}`;
}

function formatHypothesisMemoryLine(item: KnowledgeArtifactRecord): string {
  return `- Hypothesis (guarded): ${truncate(item.summary, 120)} | ${truncate(item.content, 140)}`;
}

function formatProceduralMemoryLine(item: ProceduralArtifactRecord): string {
  const chain = item.toolChain.map((step) => step.toolName).join(" -> ");
  return `- Query: ${truncate(item.query, 100)} | Tools: ${truncate(chain, 120)}`;
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

export function classifyMemoryUsageTier(
  item: Pick<KnowledgeArtifactRecord, "memoryType">,
  mode: MemoryRetrieveMode,
): MemoryUsageTier | undefined {
  switch (item.memoryType ?? "semantic") {
    case "semantic":
    case "episodic":
      return "fact";
    case "symptom":
    case "affective":
      return "pattern";
    case "repressed":
      return mode === "analytic" ? "hypothesis" : undefined;
    default:
      return undefined;
  }
}
