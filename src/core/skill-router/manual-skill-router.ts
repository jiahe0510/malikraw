import type { SkillRouteInput, SkillRouteResult, SkillRouter } from "./types.js";

export class ManualSkillRouter implements SkillRouter {
  constructor(
    private readonly activeSkillIds: readonly string[],
  ) {}

  route(_input: SkillRouteInput): SkillRouteResult {
    return {
      activeSkillIds: [...new Set(this.activeSkillIds)],
    };
  }
}
