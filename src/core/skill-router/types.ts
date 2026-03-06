export type SkillRouteInput = {
  userRequest: string;
  availableSkillIds: string[];
  history?: string;
  stateSummary?: string;
};

export type SkillRouteResult = {
  activeSkillIds: string[];
};

export interface SkillRouter {
  route(input: SkillRouteInput): Promise<SkillRouteResult> | SkillRouteResult;
}
