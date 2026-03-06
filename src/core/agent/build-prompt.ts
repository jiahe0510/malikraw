import { injectSkillPromptBlocks } from "../skill-registry/render-skill-prompt.js";
import type { PromptMessage, SelectedSkill } from "../skill-registry/types.js";
import type { AgentMessage, AgentPromptInput, BuiltPrompt } from "./types.js";

export function buildPrompt(input: AgentPromptInput): BuiltPrompt {
  const baseMessages: PromptMessage[] = [
    {
      role: "system",
      content: input.globalPolicy.trim(),
    },
    {
      role: "developer",
      content: buildRuntimeContextBlock(input),
    },
  ];

  const promptMessages = injectSkillPromptBlocks(baseMessages, input.activeSkills);
  const history = input.history ?? [];

  const messages: AgentMessage[] = [
    ...promptMessages,
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
  activeSkills: readonly SelectedSkill[],
  allToolNames: readonly string[],
): string[] {
  const constrainedSkills = activeSkills.filter((skill) =>
    (skill.metadata?.allowedTools?.length ?? 0) > 0,
  );

  if (constrainedSkills.length === 0) {
    return [...allToolNames];
  }

  const visible = new Set<string>();
  for (const skill of constrainedSkills) {
    for (const toolName of skill.metadata?.allowedTools ?? []) {
      if (allToolNames.includes(toolName)) {
        visible.add(toolName);
      }
    }
  }

  return [...visible];
}

function buildRuntimeContextBlock(input: AgentPromptInput): string {
  const sections = [
    ["Tools", input.toolSummary],
    ["State Summary", input.stateSummary ?? "None"],
    ["Memory Summary", input.memorySummary ?? "None"],
  ];

  return sections
    .map(([title, body]) => `${title}\n${body}`)
    .join("\n\n");
}
