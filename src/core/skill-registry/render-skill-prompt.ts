import type { PromptMessage, SelectedSkill, SkillPromptBlock } from "./types.js";

type RenderOptions = {
  heading?: string;
};

export function renderSkillPromptBlocks(
  skills: readonly SelectedSkill[],
  options: RenderOptions = {},
): SkillPromptBlock[] {
  const blocksByRole = new Map<SkillPromptBlock["role"], SelectedSkill[]>();

  for (const skill of skills) {
    const existing = blocksByRole.get(skill.promptRole) ?? [];
    existing.push(skill);
    blocksByRole.set(skill.promptRole, existing);
  }

  return [...blocksByRole.entries()].map(([role, roleSkills]) => ({
    role,
    skills: roleSkills.map((skill) => skill.name),
    content: renderRoleBlock(roleSkills, options.heading),
  }));
}

export function injectSkillPromptBlocks(
  baseMessages: readonly PromptMessage[],
  skills: readonly SelectedSkill[],
  options: RenderOptions = {},
): PromptMessage[] {
  const blocks = renderSkillPromptBlocks(skills, options);
  if (blocks.length === 0) {
    return [...baseMessages];
  }

  const result = [...baseMessages];
  for (const block of blocks) {
    result.push({
      role: block.role,
      content: block.content,
    });
  }

  return result;
}

function renderRoleBlock(
  skills: readonly SelectedSkill[],
  heading = "Activated Skills",
): string {
  const lines: string[] = [heading];

  for (const skill of skills) {
    lines.push("");
    lines.push(`<skill name="${skill.name}">`);
    lines.push(`description: ${skill.description}`);
    lines.push("instruction:");
    lines.push(skill.instruction.trim());
    lines.push("</skill>");
  }

  return lines.join("\n");
}
