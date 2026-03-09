import test from "node:test";
import assert from "node:assert/strict";

import {
  A2AOrchestrator,
  InMemoryEventBus,
  InMemoryTaskStore,
  StepWorkerRuntime,
  type StepCompletedContext,
} from "../index.js";

test("a2a orchestrator fans out follow-up steps based on structured worker output", async () => {
  const eventBus = new InMemoryEventBus();
  const taskStore = new InMemoryTaskStore();
  const executionOrder: string[] = [];

  const orchestrator = new A2AOrchestrator(taskStore, eventBus, {
    onStepCompleted: ({ completedStep, event }: StepCompletedContext) => {
      if (completedStep.stepName === "sub-a") {
        const output = event.output as {
          needB: boolean;
          findings: Array<{ summary: string }>;
        };
        if (output.needB) {
          return {
            nextSteps: [{
              stepName: "sub-b",
              agentId: "sub-b",
              dependsOn: [completedStep.id],
              parentStepId: completedStep.id,
              input: {
                findings: output.findings,
              },
            }],
          };
        }
      }

      if (completedStep.stepName === "sub-b") {
        return {
          completeRoot: {
            finalOutput: event.output,
          },
        };
      }

      return undefined;
    },
  });
  orchestrator.start();

  const workerA = new StepWorkerRuntime("sub-a", eventBus, async (input, context) => {
    executionOrder.push(`start:${context.assignment.stepId}`);
    await context.publishProgress(0.5, { phase: "scan" });
    const payload = input as { goal: string };
    return {
      output: {
        goal: payload.goal,
        needB: true,
        findings: [{ summary: "cache contention detected" }],
      },
    };
  });

  const workerB = new StepWorkerRuntime("sub-b", eventBus, async (input) => {
    executionOrder.push("sub-b");
    const payload = input as { findings: Array<{ summary: string }> };
    return {
      output: {
        finalSummary: `Found ${payload.findings.length} issue: ${payload.findings[0]?.summary}`,
      },
    };
  });

  workerA.start();
  workerB.start();

  const { rootTask, initialStep } = await orchestrator.startRootTask({
    input: { query: "Analyze repo" },
    initialStep: {
      stepName: "sub-a",
      agentId: "sub-a",
      workflowNodeId: "analyze",
      input: { goal: "analyze repo" },
    },
  });

  await waitFor(async () => {
    const latest = await taskStore.getRootTask(rootTask.id);
    return latest?.status === "completed";
  });

  const finalRootTask = await taskStore.getRootTask(rootTask.id);
  const steps = await taskStore.listStepTasks(rootTask.id);
  const stepEvents = await taskStore.listStepEvents(rootTask.id);

  assert.equal(finalRootTask?.status, "completed");
  assert.deepEqual(finalRootTask?.finalOutput, {
    finalSummary: "Found 1 issue: cache contention detected",
  });
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.id, initialStep.id);
  assert.equal(steps[0]?.status, "completed");
  assert.equal(steps[1]?.stepName, "sub-b");
  assert.equal(steps[1]?.status, "completed");
  assert.deepEqual(steps[1]?.dependsOn, [initialStep.id]);
  assert.ok(stepEvents.some((event) => event.type === "step.progress"));
  assert.deepEqual(executionOrder, [`start:${initialStep.id}`, "sub-b"]);
});

test("a2a orchestrator fails root task when a worker fails and no retry policy overrides it", async () => {
  const eventBus = new InMemoryEventBus();
  const taskStore = new InMemoryTaskStore();
  const orchestrator = new A2AOrchestrator(taskStore, eventBus);
  orchestrator.start();

  const worker = new StepWorkerRuntime("sub-a", eventBus, async () => {
    throw new Error("boom");
  });
  worker.start();

  const { rootTask } = await orchestrator.startRootTask({
    input: { query: "Analyze repo" },
    initialStep: {
      stepName: "sub-a",
      agentId: "sub-a",
      input: { goal: "analyze repo" },
    },
  });

  await waitFor(async () => {
    const latest = await taskStore.getRootTask(rootTask.id);
    return latest?.status === "failed";
  });

  const failedRootTask = await taskStore.getRootTask(rootTask.id);
  const steps = await taskStore.listStepTasks(rootTask.id);

  assert.equal(failedRootTask?.status, "failed");
  assert.equal(failedRootTask?.error?.code, "worker_execution_failed");
  assert.equal(steps[0]?.status, "failed");
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}
