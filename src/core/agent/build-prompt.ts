import { injectSkillPromptBlocks } from "../skill-registry/render-skill-prompt.js";
import type { PromptMessage, SelectedSkill } from "../skill-registry/types.js";
import type { AgentMessage, AgentPromptInput, BuiltPrompt } from "./types.js";

const LEGACY_SESSION_SUMMARY_PREFIX = "[session_summary]\n";
const COMPACTED_HISTORY_PREFIX = "[compacted_history]\n";

export function buildPrompt(input: AgentPromptInput): BuiltPrompt {
  const history = normalizeCompactedHistory(input.history ?? []);
  const baseMessages: PromptMessage[] = [
    {
      role: "system",
      content: input.globalPolicy.trim(),
    },
    ...toSystemMessages("Identity", input.identitySystemContent),
    ...toSystemMessages("Personality", input.personalitySystemContent),
    ...toSystemMessages("Workspace AGENT.md", input.agentSystemContent),
    {
      role: "developer",
      content: buildRuntimeContextBlock(input),
    },
  ];

  const promptMessages = injectSkillPromptBlocks(baseMessages, input.activeSkills);
  const userContextReminder = buildUserContextReminder(input);

  const messages: AgentMessage[] = [
    ...promptMessages,
    ...(userContextReminder ? [{
      role: "user" as const,
      content: userContextReminder,
    }] : []),
    ...history,
    {
      role: "user",
      content: input.userRequest,
    },
  ];

  return {
    messages,
    activeSkillIds: input.activeSkills.map((skill) => skill.name),
  };
}

export function getVisibleToolNames(
  _activeSkills: readonly SelectedSkill[],
  allToolNames: readonly string[],
): string[] {
  return [...allToolNames];
}

function toSystemMessages(title: string, content: string | undefined): PromptMessage[] {
  const trimmed = content?.trim();
  if (!trimmed) {
    return [];
  }

  return [{
    role: "system",
    content: [title, trimmed].join("\n\n"),
  }];
}

function buildRuntimeContextBlock(input: AgentPromptInput): string {
  const systemContextLines = toContextLines(input.systemContext);
  return [
    "Runtime Context",
    "- Visible tools:",
    ...toToolLines(input.toolSummary),
    `- State summary: ${input.stateSummary ?? "No state summary provided."}`,
    `- Memory summary: ${input.memorySummary ?? "No memory summary provided."}`,
    ...(systemContextLines.length > 0
      ? ["- System context:", ...systemContextLines.map((line) => `  - ${line}`)]
      : []),
  ].join("\n");
}

function toToolLines(toolSummary: string): string[] {
  const trimmed = toolSummary.trim();
  if (!trimmed || trimmed === "No tools are currently available.") {
    return ["  - No tools are currently available."];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.startsWith("- ") ? `  ${line}` : `  - ${line}`);
}

function normalizeCompactedHistory(history: AgentMessage[]): AgentMessage[] {
  return history.map((message) => {
    if (message.role === "assistant" && message.content.startsWith(LEGACY_SESSION_SUMMARY_PREFIX)) {
      return {
        role: "user" as const,
        content: `${COMPACTED_HISTORY_PREFIX}${message.content.slice(LEGACY_SESSION_SUMMARY_PREFIX.length).trim()}`,
      };
    }

    return message;
  });
}

function buildUserContextReminder(input: AgentPromptInput): string | undefined {
  const sections = [
    ["Workspace MEMORY.md", input.memorySystemContent],
    ["Retrieved Memory", input.relevantMemoryBlock],
    ...Object.entries(input.userContext ?? {}),
  ]
    .map(([title, content]) => {
      const trimmed = content?.trim();
      if (!trimmed) {
        return undefined;
      }

      return `# ${title}\n${trimmed}`;
    })
    .filter((value): value is string => Boolean(value));

  if (sections.length === 0) {
    return undefined;
  }

  return [
    "<system-reminder>",
    "Use the following context when it helps answer the user's request.",
    "",
    ...sections,
    "</system-reminder>",
  ].join("\n");
}

function toContextLines(
  context: Record<string, string | undefined> | undefined,
): string[] {
  if (!context) {
    return [];
  }

  return Object.entries(context)
    .map(([key, value]) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return undefined;
      }

      return `${key}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
}
