export type PromptRole = "system" | "developer";

export type SkillSpec = {
  name: string;
  description: string;
  instruction: string;
  promptRole?: PromptRole;
  metadata?: {
    tags?: string[];
    version?: string;
    owner?: string;
  };
};

export type SelectedSkill = {
  name: string;
  promptRole: PromptRole;
  instruction: string;
  description: string;
};

export type SkillLookupError = {
  type: "skill_not_found";
  message: string;
  skillName: string;
};

export type SkillSelectionResult =
  | {
      ok: true;
      skills: SelectedSkill[];
    }
  | {
      ok: false;
      error: SkillLookupError;
    };

export type PromptMessage = {
  role: PromptRole;
  content: string;
};

export type SkillPromptBlock = {
  role: PromptRole;
  content: string;
  skills: string[];
};

export function defineSkill(skill: SkillSpec): SkillSpec {
  return {
    ...skill,
    promptRole: skill.promptRole ?? "developer",
  };
}
