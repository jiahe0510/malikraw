import {
  createTaskId,
  createTimestamp,
  type CompleteRootResult,
  type CompleteStepResult,
  type CreateRootTaskInput,
  type CreateStepTaskInput,
  type RootTask,
  type StepEvent,
  type StepTask,
  type TaskError,
} from "./types.js";
import type { TaskStore } from "./task-store.js";

export class InMemoryTaskStore implements TaskStore {
  private readonly rootTasks = new Map<string, RootTask>();
  private readonly stepTasks = new Map<string, StepTask>();
  private readonly events = new Map<string, StepEvent[]>();

  async createRootTask(input: CreateRootTaskInput): Promise<RootTask> {
    const now = createTimestamp();
    const task: RootTask = {
      id: input.id ?? createTaskId("root"),
      status: "running",
      input: input.input,
      createdAt: now,
      updatedAt: now,
    };
    this.rootTasks.set(task.id, task);
    return task;
  }

  async getRootTask(rootTaskId: string): Promise<RootTask | undefined> {
    return this.rootTasks.get(rootTaskId);
  }

  async listRootTasks(): Promise<RootTask[]> {
    return [...this.rootTasks.values()];
  }

  async markRootCompleted(rootTaskId: string, result?: CompleteRootResult): Promise<RootTask> {
    return this.updateRootTask(rootTaskId, (current) => ({
      ...current,
      status: "completed",
      finalOutput: result?.finalOutput ?? current.finalOutput,
      finalOutputRef: result?.finalOutputRef ?? current.finalOutputRef,
      error: undefined,
    }));
  }

  async markRootFailed(rootTaskId: string, error: TaskError): Promise<RootTask> {
    return this.updateRootTask(rootTaskId, (current) => ({
      ...current,
      status: "failed",
      error,
    }));
  }

  async createStepTask(input: CreateStepTaskInput): Promise<StepTask> {
    const rootTask = this.rootTasks.get(input.rootTaskId);
    if (!rootTask) {
      throw new Error(`Root task "${input.rootTaskId}" was not found.`);
    }

    const now = createTimestamp();
    const step: StepTask = {
      id: input.id ?? createTaskId("step"),
      rootTaskId: input.rootTaskId,
      stepName: input.stepName,
      agentId: input.agentId,
      status: "queued",
      attempt: input.attempt ?? 1,
      workflowNodeId: input.workflowNodeId,
      parentStepId: input.parentStepId,
      dependsOn: input.dependsOn,
      input: input.input,
      createdAt: now,
      updatedAt: now,
    };
    this.stepTasks.set(step.id, step);
    return step;
  }

  async getStepTask(stepId: string): Promise<StepTask | undefined> {
    return this.stepTasks.get(stepId);
  }

  async listStepTasks(rootTaskId: string): Promise<StepTask[]> {
    return [...this.stepTasks.values()]
      .filter((step) => step.rootTaskId === rootTaskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async markStepRunning(stepId: string, at = createTimestamp()): Promise<StepTask> {
    return this.updateStepTask(stepId, (current) => ({
      ...current,
      status: "running",
      updatedAt: at,
    }));
  }

  async markStepCompleted(stepId: string, result: CompleteStepResult, at = createTimestamp()): Promise<StepTask> {
    return this.updateStepTask(stepId, (current) => ({
      ...current,
      status: "completed",
      output: result.output ?? current.output,
      outputRef: result.outputRef ?? current.outputRef,
      error: undefined,
      updatedAt: at,
    }));
  }

  async markStepFailed(stepId: string, error: TaskError, at = createTimestamp()): Promise<StepTask> {
    return this.updateStepTask(stepId, (current) => ({
      ...current,
      status: "failed",
      error,
      updatedAt: at,
    }));
  }

  async appendStepEvent(event: StepEvent): Promise<void> {
    const events = this.events.get(event.rootTaskId) ?? [];
    events.push(event);
    this.events.set(event.rootTaskId, events);
  }

  async listStepEvents(rootTaskId: string): Promise<StepEvent[]> {
    return [...(this.events.get(rootTaskId) ?? [])];
  }

  private updateRootTask(rootTaskId: string, updater: (current: RootTask) => RootTask): RootTask {
    const current = this.rootTasks.get(rootTaskId);
    if (!current) {
      throw new Error(`Root task "${rootTaskId}" was not found.`);
    }

    const next = {
      ...updater(current),
      updatedAt: createTimestamp(),
    };
    this.rootTasks.set(rootTaskId, next);
    return next;
  }

  private updateStepTask(stepId: string, updater: (current: StepTask) => StepTask): StepTask {
    const current = this.stepTasks.get(stepId);
    if (!current) {
      throw new Error(`Step task "${stepId}" was not found.`);
    }

    const next = updater(current);
    this.stepTasks.set(stepId, next);
    return next;
  }
}
