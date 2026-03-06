import type {
  SelectedSkill,
  SkillLookupError,
  SkillSelectionResult,
  SkillSpec,
} from "./types.js";

export class SkillRegistry {
  private readonly skills = new Map<string, SkillSpec>();

  register<TSkill extends SkillSpec>(skill: TSkill): TSkill {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" is already registered.`);
    }

    this.skills.set(skill.name, {
      ...skill,
      promptRole: skill.promptRole ?? "developer",
    });
    return skill;
  }

  get(skillName: string): SkillSpec | undefined {
    return this.skills.get(skillName);
  }

  list(): SkillSpec[] {
    return [...this.skills.values()];
  }

  select(skillNames: readonly string[]): SkillSelectionResult {
    const selected: SelectedSkill[] = [];

    for (const skillName of skillNames) {
      const skill = this.skills.get(skillName);
      if (!skill) {
        return {
          ok: false,
          error: lookupError(skillName),
        };
      }

      selected.push({
        name: skill.name,
        promptRole: skill.promptRole ?? "developer",
        instruction: skill.instruction,
        description: skill.description,
        metadata: skill.metadata,
      });
    }

    return {
      ok: true,
      skills: dedupeSelectedSkills(selected),
    };
  }
}

function lookupError(skillName: string): SkillLookupError {
  return {
    type: "skill_not_found",
    message: `Skill "${skillName}" is not registered.`,
    skillName,
  };
}

function dedupeSelectedSkills(skills: SelectedSkill[]): SelectedSkill[] {
  const seen = new Set<string>();
  const result: SelectedSkill[] = [];

  for (const skill of skills) {
    if (seen.has(skill.name)) {
      continue;
    }

    seen.add(skill.name);
    result.push(skill);
  }

  return result;
}
