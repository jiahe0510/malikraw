import { randomUUID } from "node:crypto";

export type RootTaskStatus = "running" | "completed" | "failed" | "canceled";
export type StepTaskStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type TaskError = {
  code: string;
  message: string;
};

export type ArtifactRef = {
  id: string;
  path: string;
  mimeType?: string;
};

export type RootTask = {
  id: string;
  status: RootTaskStatus;
  input: unknown;
  finalOutput?: unknown;
  finalOutputRef?: string;
  error?: TaskError;
  createdAt: string;
  updatedAt: string;
};

export type StepTask = {
  id: string;
  rootTaskId: string;
  stepName: string;
  agentId: string;
  status: StepTaskStatus;
  attempt: number;
  workflowNodeId?: string;
  parentStepId?: string;
  dependsOn?: string[];
  input: unknown;
  output?: unknown;
  outputRef?: string;
  error?: TaskError;
  createdAt: string;
  updatedAt: string;
};

type StepEventBase = {
  id: string;
  stepId: string;
  rootTaskId: string;
  at: string;
};

export type StepStartedEvent = StepEventBase & {
  type: "step.started";
};

export type StepProgressEvent = StepEventBase & {
  type: "step.progress";
  progress: number;
  payload?: unknown;
};

export type StepCompletedEvent = StepEventBase & {
  type: "step.completed";
  output?: unknown;
  outputRef?: string;
};

export type StepFailedEvent = StepEventBase & {
  type: "step.failed";
  error: TaskError;
};

export type StepEvent =
  | StepStartedEvent
  | StepProgressEvent
  | StepCompletedEvent
  | StepFailedEvent;

export type StepAssignment = {
  type: "step.assignment";
  rootTaskId: string;
  stepId: string;
  agentId: string;
  input: unknown;
  deadlineMs?: number;
};

export type CreateRootTaskInput = {
  id?: string;
  input: unknown;
};

export type CreateStepTaskInput = {
  id?: string;
  rootTaskId: string;
  stepName: string;
  agentId: string;
  attempt?: number;
  workflowNodeId?: string;
  parentStepId?: string;
  dependsOn?: string[];
  input: unknown;
};

export type CompleteStepResult = {
  output?: unknown;
  outputRef?: string;
};

export type CompleteRootResult = {
  finalOutput?: unknown;
  finalOutputRef?: string;
};

export type CreateNextStepInput = Omit<CreateStepTaskInput, "rootTaskId">;

export function createTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function createTaskId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
