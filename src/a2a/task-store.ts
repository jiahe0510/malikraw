import type {
  CompleteRootResult,
  CompleteStepResult,
  CreateRootTaskInput,
  CreateStepTaskInput,
  RootTask,
  StepEvent,
  StepTask,
  TaskError,
} from "./types.js";

export interface TaskStore {
  createRootTask(input: CreateRootTaskInput): Promise<RootTask>;
  getRootTask(rootTaskId: string): Promise<RootTask | undefined>;
  listRootTasks(): Promise<RootTask[]>;
  markRootCompleted(rootTaskId: string, result?: CompleteRootResult): Promise<RootTask>;
  markRootFailed(rootTaskId: string, error: TaskError): Promise<RootTask>;

  createStepTask(input: CreateStepTaskInput): Promise<StepTask>;
  getStepTask(stepId: string): Promise<StepTask | undefined>;
  listStepTasks(rootTaskId: string): Promise<StepTask[]>;
  markStepRunning(stepId: string, at?: string): Promise<StepTask>;
  markStepCompleted(stepId: string, result: CompleteStepResult, at?: string): Promise<StepTask>;
  markStepFailed(stepId: string, error: TaskError, at?: string): Promise<StepTask>;

  appendStepEvent(event: StepEvent): Promise<void>;
  listStepEvents(rootTaskId: string): Promise<StepEvent[]>;
}
