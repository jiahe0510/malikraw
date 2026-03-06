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
  heading = "Active Skills",
): string {
  const lines: string[] = [heading];

  for (const skill of skills) {
    lines.push("");
    lines.push(`Skill: ${skill.name}`);
    lines.push(`- Description: ${skill.description}`);
    if (skill.metadata?.allowedTools && skill.metadata.allowedTools.length > 0) {
      lines.push(`- Tool constraint: You may use only these tools: ${skill.metadata.allowedTools.join(", ")}`);
    }
    lines.push("- Required behavior:");
    for (const item of toBulletLines(skill.instruction)) {
      lines.push(`  - ${item}`);
    }
    if (skill.metadata?.examples && skill.metadata.examples.length > 0) {
      lines.push("- Output style examples:");
      for (const example of skill.metadata.examples) {
        lines.push(`  - ${example}`);
      }
    }
  }

  return lines.join("\n");
}

function toBulletLines(instruction: string): string[] {
  return instruction
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
