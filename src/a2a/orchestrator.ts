import type { EventBus } from "./event-bus.js";
import type { TaskStore } from "./task-store.js";
import type {
  CompleteRootResult,
  CreateNextStepInput,
  CreateStepTaskInput,
  RootTask,
  StepCompletedEvent,
  StepEvent,
  StepFailedEvent,
  StepTask,
  TaskError,
} from "./types.js";

export type StepCompletedContext = {
  rootTask: RootTask;
  completedStep: StepTask;
  event: StepCompletedEvent;
  taskStore: TaskStore;
};

export type StepFailedContext = {
  rootTask: RootTask;
  failedStep: StepTask;
  event: StepFailedEvent;
  taskStore: TaskStore;
};

export type OrchestratorDecision = {
  nextSteps?: CreateNextStepInput[];
  completeRoot?: CompleteRootResult;
  failRoot?: TaskError;
};

export type OrchestratorPlanner = {
  onStepCompleted?(context: StepCompletedContext): Promise<OrchestratorDecision | void> | OrchestratorDecision | void;
  onStepFailed?(context: StepFailedContext): Promise<OrchestratorDecision | void> | OrchestratorDecision | void;
};

export type StartRootTaskInput = {
  input: unknown;
  initialStep: Omit<CreateStepTaskInput, "rootTaskId">;
};

export class A2AOrchestrator {
  private unsubscribeEvents?: () => void;

  constructor(
    private readonly taskStore: TaskStore,
    private readonly eventBus: EventBus,
    private readonly planner: OrchestratorPlanner = {},
  ) {}

  start(): void {
    if (this.unsubscribeEvents) {
      return;
    }

    this.unsubscribeEvents = this.eventBus.subscribeEvents(async (event) => {
      await this.handleStepEvent(event);
    });
  }

  stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
  }

  async startRootTask(input: StartRootTaskInput): Promise<{ rootTask: RootTask; initialStep: StepTask }> {
    const rootTask = await this.taskStore.createRootTask({ input: input.input });
    const initialStep = await this.taskStore.createStepTask({
      ...input.initialStep,
      rootTaskId: rootTask.id,
    });
    await this.eventBus.publishAssignment(toAssignment(initialStep));
    return { rootTask, initialStep };
  }

  async handleStepEvent(event: StepEvent): Promise<void> {
    await this.taskStore.appendStepEvent(event);
    const rootTask = await this.taskStore.getRootTask(event.rootTaskId);
    if (!rootTask || rootTask.status !== "running") {
      return;
    }

    if (event.type === "step.started") {
      await this.taskStore.markStepRunning(event.stepId, event.at);
      return;
    }

    if (event.type === "step.progress") {
      return;
    }

    const stepTask = await this.taskStore.getStepTask(event.stepId);
    if (!stepTask) {
      throw new Error(`Step task "${event.stepId}" was not found.`);
    }

    if (event.type === "step.completed") {
      await this.taskStore.markStepCompleted(event.stepId, {
        output: event.output,
        outputRef: event.outputRef,
      }, event.at);
      const decision = await this.planner.onStepCompleted?.({
        rootTask,
        completedStep: stepTask,
        event,
        taskStore: this.taskStore,
      }) ?? {};
      await this.applyDecision(rootTask.id, stepTask, event, decision);
      return;
    }

    await this.taskStore.markStepFailed(event.stepId, event.error, event.at);
    const decision = await this.planner.onStepFailed?.({
      rootTask,
      failedStep: stepTask,
      event,
      taskStore: this.taskStore,
    }) ?? {
      failRoot: event.error,
    };
    await this.applyDecision(rootTask.id, stepTask, event, decision);
  }

  private async applyDecision(
    rootTaskId: string,
    currentStep: StepTask,
    event: StepCompletedEvent | StepFailedEvent,
    decision: OrchestratorDecision,
  ): Promise<void> {
    if (decision.failRoot) {
      await this.taskStore.markRootFailed(rootTaskId, decision.failRoot);
      return;
    }

    for (const nextStepInput of decision.nextSteps ?? []) {
      const stepTask = await this.taskStore.createStepTask({
        ...nextStepInput,
        rootTaskId,
      });
      await this.eventBus.publishAssignment(toAssignment(stepTask));
    }

    if ((decision.nextSteps?.length ?? 0) > 0) {
      return;
    }

    if (decision.completeRoot) {
      await this.taskStore.markRootCompleted(rootTaskId, decision.completeRoot);
      return;
    }

    const steps = await this.taskStore.listStepTasks(rootTaskId);
    const hasActiveSteps = steps.some((step) => step.status === "queued" || step.status === "running");
    if (hasActiveSteps) {
      return;
    }

    if (event.type === "step.failed") {
      await this.taskStore.markRootFailed(rootTaskId, event.error);
      return;
    }

    await this.taskStore.markRootCompleted(rootTaskId, {
      finalOutput: currentStep.output ?? event.output,
      finalOutputRef: currentStep.outputRef ?? event.outputRef,
    });
  }
}

function toAssignment(stepTask: StepTask) {
  return {
    type: "step.assignment" as const,
    rootTaskId: stepTask.rootTaskId,
    stepId: stepTask.id,
    agentId: stepTask.agentId,
    input: stepTask.input,
  };
}
