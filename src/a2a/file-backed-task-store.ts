import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskStore } from "./task-store.js";
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

export class FileBackedTaskStore implements TaskStore {
  constructor(private readonly baseDirectory: string) {}

  async createRootTask(input: CreateRootTaskInput): Promise<RootTask> {
    const now = createTimestamp();
    const task: RootTask = {
      id: input.id ?? createTaskId("root"),
      status: "running",
      input: input.input,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeRootTask(task);
    return task;
  }

  async getRootTask(rootTaskId: string): Promise<RootTask | undefined> {
    return this.readJsonFile<RootTask>(this.getRootTaskPath(rootTaskId));
  }

  async listRootTasks(): Promise<RootTask[]> {
    const directory = this.getRootsDirectory();
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const tasks = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.getRootTask(entry.name)));
      return tasks
        .filter((task): task is RootTask => task !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async markRootCompleted(rootTaskId: string, result?: CompleteRootResult): Promise<RootTask> {
    const current = await this.requireRootTask(rootTaskId);
    const next: RootTask = {
      ...current,
      status: "completed",
      finalOutput: result?.finalOutput ?? current.finalOutput,
      finalOutputRef: result?.finalOutputRef ?? current.finalOutputRef,
      error: undefined,
      updatedAt: createTimestamp(),
    };
    await this.writeRootTask(next);
    return next;
  }

  async markRootFailed(rootTaskId: string, error: TaskError): Promise<RootTask> {
    const current = await this.requireRootTask(rootTaskId);
    const next: RootTask = {
      ...current,
      status: "failed",
      error,
      updatedAt: createTimestamp(),
    };
    await this.writeRootTask(next);
    return next;
  }

  async createStepTask(input: CreateStepTaskInput): Promise<StepTask> {
    await this.requireRootTask(input.rootTaskId);
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
    await this.writeStepTask(step);
    return step;
  }

  async getStepTask(stepId: string): Promise<StepTask | undefined> {
    const location = await this.findStepPath(stepId);
    if (!location) {
      return undefined;
    }
    return this.readJsonFile<StepTask>(location);
  }

  async listStepTasks(rootTaskId: string): Promise<StepTask[]> {
    await this.requireRootTask(rootTaskId);
    const directory = this.getStepsDirectory(rootTaskId);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const steps = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readJsonFile<StepTask>(path.join(directory, entry.name))));
      return steps
        .filter((step): step is StepTask => step !== undefined)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
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
    const events = await this.listStepEvents(event.rootTaskId);
    events.push(event);
    await this.writeJsonFile(this.getEventsPath(event.rootTaskId), events);
  }

  async listStepEvents(rootTaskId: string): Promise<StepEvent[]> {
    await this.requireRootTask(rootTaskId);
    return (await this.readJsonFile<StepEvent[]>(this.getEventsPath(rootTaskId))) ?? [];
  }

  private async requireRootTask(rootTaskId: string): Promise<RootTask> {
    const task = await this.getRootTask(rootTaskId);
    if (!task) {
      throw new Error(`Root task "${rootTaskId}" was not found.`);
    }
    return task;
  }

  private async updateStepTask(stepId: string, updater: (current: StepTask) => StepTask): Promise<StepTask> {
    const filePath = await this.findStepPath(stepId);
    if (!filePath) {
      throw new Error(`Step task "${stepId}" was not found.`);
    }
    const current = await this.readJsonFile<StepTask>(filePath);
    if (!current) {
      throw new Error(`Step task "${stepId}" was not found.`);
    }
    const next = updater(current);
    await this.writeJsonFile(filePath, next);
    return next;
  }

  private async findStepPath(stepId: string): Promise<string | undefined> {
    const roots = await this.listRootTasks();
    for (const root of roots) {
      const candidate = this.getStepTaskPath(root.id, stepId);
      const step = await this.readJsonFile<StepTask>(candidate);
      if (step) {
        return candidate;
      }
    }
    return undefined;
  }

  private async writeRootTask(task: RootTask): Promise<void> {
    await this.writeJsonFile(this.getRootTaskPath(task.id), task);
  }

  private async writeStepTask(step: StepTask): Promise<void> {
    await this.writeJsonFile(this.getStepTaskPath(step.rootTaskId, step.id), step);
  }

  private getRootsDirectory(): string {
    return path.join(this.baseDirectory, "roots");
  }

  private getRootDirectory(rootTaskId: string): string {
    return path.join(this.getRootsDirectory(), rootTaskId);
  }

  private getRootTaskPath(rootTaskId: string): string {
    return path.join(this.getRootDirectory(rootTaskId), "root.json");
  }

  private getStepsDirectory(rootTaskId: string): string {
    return path.join(this.getRootDirectory(rootTaskId), "steps");
  }

  private getStepTaskPath(rootTaskId: string, stepId: string): string {
    return path.join(this.getStepsDirectory(rootTaskId), `${stepId}.json`);
  }

  private getEventsPath(rootTaskId: string): string {
    return path.join(this.getRootDirectory(rootTaskId), "events.json");
  }

  private async readJsonFile<T>(filePath: string): Promise<T | undefined> {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
