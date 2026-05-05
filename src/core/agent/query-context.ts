import { injectSkillPromptBlocks } from "../skill-registry/render-skill-prompt.js";
import type { PromptMessage } from "../skill-registry/types.js";
import { createTextMessage } from "./message-content.js";
import type { AgentMessage, AgentPromptInput, BuiltPrompt, QueryContext } from "./types.js";

const LEGACY_SESSION_SUMMARY_PREFIX = "[session_summary]\n";
const COMPACTED_HISTORY_PREFIX = "[compacted_history]\n";

export function collectQueryContext(input: AgentPromptInput): QueryContext {
  const baseMessages: PromptMessage[] = [
    {
      role: "system",
      content: input.globalPolicy.trim(),
      cacheControl: { type: "ephemeral" },
    },
    ...toSystemMessages("Identity", input.identitySystemContent),
    ...toSystemMessages("Personality", input.personalitySystemContent),
    ...toSystemMessages("Workspace AGENT.md", input.agentSystemContent),
  ];

  const instructionMessages = [
    ...injectSkillPromptBlocks(baseMessages, input.activeSkills),
    {
      role: "developer" as const,
      content: buildRuntimeContextBlock(input.toolSummary, input.stateSummary, input.memorySummary),
      cacheControl: { type: "ephemeral" as const },
    },
    ...toDeveloperMessages("Memory Usage Guidance", input.memorySystemContent),
  ];

  return {
    instructionMessages,
    userContext: input.userContext ?? {},
    systemContext: input.systemContext ?? {},
    memorySystemContent: input.memorySystemContent,
    relevantMemoryBlock: input.relevantMemoryBlock,
    history: normalizeCompactedHistory(input.history ?? []),
    userRequest: input.userRequest,
    activeSkillIds: input.activeSkills.map((skill) => skill.name),
  };
}

export function finalizeQueryContext(context: QueryContext): BuiltPrompt {
  const instructionMessages = [
    ...context.instructionMessages,
    ...missingMemoryGuidanceMessages(context.instructionMessages, context.memorySystemContent),
  ];
  const dynamicRuntimeContext = buildDynamicRuntimeContextBlock(context.systemContext);
  const userContextReminder = buildUserContextReminder(context);

  const messages: AgentMessage[] = [
    ...instructionMessages.map((message) =>
      createTextMessage(message.role, message.content, { cacheControl: message.cacheControl })
    ),
    ...(dynamicRuntimeContext ? [createTextMessage("developer", dynamicRuntimeContext)] : []),
    ...(userContextReminder ? [createTextMessage("user", userContextReminder)] : []),
    ...context.history,
    createTextMessage("user", context.userRequest),
  ];

  return {
    messages,
    activeSkillIds: context.activeSkillIds,
  };
}

function missingMemoryGuidanceMessages(
  instructionMessages: readonly PromptMessage[],
  memorySystemContent: string | undefined,
): PromptMessage[] {
  if (instructionMessages.some((message) => message.content.startsWith("Memory Usage Guidance"))) {
    return [];
  }

  return toDeveloperMessages("Memory Usage Guidance", memorySystemContent);
}

export function buildPrompt(input: AgentPromptInput): BuiltPrompt {
  return finalizeQueryContext(collectQueryContext(input));
}

function buildDynamicRuntimeContextBlock(systemContext: Record<string, string | undefined>): string | undefined {
  const systemContextLines = toContextLines(systemContext);
  if (systemContextLines.length === 0) {
    return undefined;
  }

  return [
    "Dynamic Runtime Context",
    "- System context:",
    ...systemContextLines.map((line) => `  - ${line}`),
  ].join("\n");
}

function buildRuntimeContextBlock(
  toolSummary: string,
  stateSummary: string | undefined,
  memorySummary: string | undefined,
): string {
  return [
    "Runtime Context",
    "- Visible tools:",
    ...toToolLines(toolSummary),
    `- State summary: ${stateSummary ?? "No state summary provided."}`,
    `- Memory summary: ${memorySummary ?? "No memory summary provided."}`,
  ].join("\n");
}

function toSystemMessages(title: string, content: string | undefined): PromptMessage[] {
  const trimmed = content?.trim();
  if (!trimmed) {
    return [];
  }

  return [{
    role: "system",
    content: [title, trimmed].join("\n\n"),
    cacheControl: { type: "ephemeral" },
  }];
}

function toDeveloperMessages(title: string, content: string | undefined): PromptMessage[] {
  const trimmed = content?.trim();
  if (!trimmed) {
    return [];
  }

  return [{
    role: "developer",
    content: [title, trimmed].join("\n\n"),
    cacheControl: { type: "ephemeral" },
  }];
}

function buildUserContextReminder(context: QueryContext): string | undefined {
  const sections = [
    ["Retrieved Memory", context.relevantMemoryBlock],
    ...Object.entries(context.userContext),
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

function toContextLines(context: Record<string, string | undefined>): string[] {
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

function normalizeCompactedHistory(history: AgentMessage[]): AgentMessage[] {
  return history.map((message) => {
    if (message.role === "assistant" && message.content.startsWith(LEGACY_SESSION_SUMMARY_PREFIX)) {
      return createTextMessage(
        "user",
        `${COMPACTED_HISTORY_PREFIX}${message.content.slice(LEGACY_SESSION_SUMMARY_PREFIX.length).trim()}`,
      );
    }

    return message;
  });
}
