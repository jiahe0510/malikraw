import type { StepAssignment, StepEvent } from "./types.js";

export type AssignmentHandler = (assignment: StepAssignment) => Promise<void> | void;
export type StepEventHandler = (event: StepEvent) => Promise<void> | void;

export interface EventBus {
  publishAssignment(assignment: StepAssignment): Promise<void>;
  publishEvent(event: StepEvent): Promise<void>;
  subscribeAssignments(agentId: string, handler: AssignmentHandler): () => void;
  subscribeEvents(handler: StepEventHandler): () => void;
}
