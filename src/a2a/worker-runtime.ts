import { createTaskId, createTimestamp, type StepAssignment } from "./types.js";
import type { ArtifactStore, WriteArtifactInput } from "./artifact-store.js";
import type { EventBus } from "./event-bus.js";

export type WorkerExecutionResult = {
  output?: unknown;
  outputRef?: string;
  artifact?: Omit<WriteArtifactInput, "rootTaskId" | "stepId">;
};

export type WorkerExecutionContext = {
  assignment: StepAssignment;
  publishProgress(progress: number, payload?: unknown): Promise<void>;
};

export type WorkerHandler = (
  input: unknown,
  context: WorkerExecutionContext,
) => Promise<WorkerExecutionResult> | WorkerExecutionResult;

export class StepWorkerRuntime {
  private unsubscribeAssignments?: () => void;

  constructor(
    private readonly agentId: string,
    private readonly eventBus: EventBus,
    private readonly handler: WorkerHandler,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  start(): void {
    if (this.unsubscribeAssignments) {
      return;
    }

    this.unsubscribeAssignments = this.eventBus.subscribeAssignments(this.agentId, async (assignment) => {
      await this.processAssignment(assignment);
    });
  }

  stop(): void {
    this.unsubscribeAssignments?.();
    this.unsubscribeAssignments = undefined;
  }

  private async processAssignment(assignment: StepAssignment): Promise<void> {
    const startedAt = createTimestamp();
    await this.eventBus.publishEvent({
      type: "step.started",
      id: createTaskId("event"),
      rootTaskId: assignment.rootTaskId,
      stepId: assignment.stepId,
      at: startedAt,
    });

    try {
      const result = await this.handler(assignment.input, {
        assignment,
        publishProgress: async (progress, payload) => {
          await this.eventBus.publishEvent({
            type: "step.progress",
            id: createTaskId("event"),
            rootTaskId: assignment.rootTaskId,
            stepId: assignment.stepId,
            progress,
            payload,
            at: createTimestamp(),
          });
        },
      });

      const outputRef = result.outputRef ?? await this.persistArtifactIfNeeded(assignment, result.artifact);
      await this.eventBus.publishEvent({
        type: "step.completed",
        id: createTaskId("event"),
        rootTaskId: assignment.rootTaskId,
        stepId: assignment.stepId,
        output: result.output,
        outputRef,
        at: createTimestamp(),
      });
    } catch (error) {
      await this.eventBus.publishEvent({
        type: "step.failed",
        id: createTaskId("event"),
        rootTaskId: assignment.rootTaskId,
        stepId: assignment.stepId,
        error: {
          code: "worker_execution_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        at: createTimestamp(),
      });
    }
  }

  private async persistArtifactIfNeeded(
    assignment: StepAssignment,
    artifact: WorkerExecutionResult["artifact"],
  ): Promise<string | undefined> {
    if (!artifact) {
      return undefined;
    }
    if (!this.artifactStore) {
      throw new Error(`Worker "${this.agentId}" produced an artifact without an artifact store.`);
    }

    const ref = await this.artifactStore.writeArtifact({
      ...artifact,
      rootTaskId: assignment.rootTaskId,
      stepId: assignment.stepId,
    });
    return ref.path;
  }
}
