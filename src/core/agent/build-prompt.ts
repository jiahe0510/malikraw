import type { SelectedSkill } from "../skill-registry/types.js";
import { buildPrompt, collectQueryContext, finalizeQueryContext } from "./query-context.js";

export { buildPrompt, collectQueryContext, finalizeQueryContext } from "./query-context.js";

export function getVisibleToolNames(
  _activeSkills: readonly SelectedSkill[],
  allToolNames: readonly string[],
): string[] {
  return [...allToolNames];
}
