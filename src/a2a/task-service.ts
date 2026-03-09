import path from "node:path";

import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
import type { AgentMessage } from "../core/agent/types.js";
import type { RuntimeConfig } from "../core/config/agent-config.js";
import { OpenAICompatibleModel } from "../integrations/openai-compatible-model.js";
import type { AgentRuntime } from "../runtime/create-agent-runtime.js";
import {
  A2AOrchestrator,
  FileArtifactStore,
  FileBackedA2ATraceLog,
  FileBackedTaskStore,
  InMemoryAgentCardRegistry,
  InMemoryEventBus,
  ModelBasedAgentRouter,
  ModelBasedTaskPlanner,
  StepWorkerRuntime,
  type AgentCard,
  type OrchestratorPlanner,
  type RootTask,
} from "./index.js";

type TaskWorkflowTransition = {
  on: string;
  when?: {
    path: string;
    equals?: unknown;
  };
  createStep: {
    stepName: string;
    agentId?: string;
    taskKind?: string;
    goal?: string;
    requiredCapabilities?: string[];
    workflowNodeId?: string;
    input?: unknown;
    inputFromOutputPath?: string;
  };
};

type TaskWorkflowDefinition = {
  transitions?: TaskWorkflowTransition[];
};

type NormalizedInitialStep = {
  stepName: string;
  agentId?: string;
  taskKind?: string;
  workflowNodeId?: string;
  input: unknown;
};

export type A2ATaskCreateRequest = {
  input?: unknown;
  workflow?: TaskWorkflowDefinition;
  initialStep: NormalizedInitialStep;
};

export type A2ATaskService = {
  createTask(body: Record<string, unknown>): Promise<{
    ok: true;
    rootTaskId: string;
    status: string;
    initialStepId: string;
  }>;
  planAndCreateTask(userRequest: string): Promise<{
    ok: true;
    rootTaskId: string;
    status: string;
    initialStepId: string;
  }>;
  getTask(rootTaskId: string): Promise<RootTask | undefined>;
  listTasks(): Promise<RootTask[]>;
  listSteps(rootTaskId: string): Promise<unknown[] | undefined>;
  listEvents(rootTaskId: string): Promise<unknown[] | undefined>;
};

export function createA2ATaskService(
  config: RuntimeConfig,
  runtimes: Map<string, AgentRuntime>,
): A2ATaskService {
  const baseDirectory = path.join(getMalikrawHomeDirectory(), ".runtime", "a2a");
  const taskStore = new FileBackedTaskStore(baseDirectory);
  const eventBus = new InMemoryEventBus();
  const traceLog = new FileBackedA2ATraceLog(baseDirectory);
  const agentCardRegistry = new InMemoryAgentCardRegistry(config.agentCards);
  const artifactStore = new FileArtifactStore(path.join(baseDirectory, "artifacts"));
  const router = new ModelBasedAgentRouter(
    agentCardRegistry,
    (agentId) => new OpenAICompatibleModel(requireAgentModelConfig(agentId, config)),
    config.defaultAgentId,
  );
  const taskPlanner = new ModelBasedTaskPlanner(
    new OpenAICompatibleModel(requireAgentModelConfig(config.defaultAgentId, config)),
    {
      workspaceRoot: config.workspaceRoot,
      agentCards: config.agentCards,
    },
  );

  const workflowPlanner: OrchestratorPlanner = {
    onStepCompleted: async ({ rootTask, completedStep, event }) => {
      const workflow = readWorkflow(rootTask);
      const transitions = workflow.transitions?.filter((transition) =>
        transition.on === (completedStep.workflowNodeId ?? completedStep.stepName)
      ) ?? [];

      const nextSteps = await Promise.all(transitions
        .filter((transition) => matchesCondition(event.output, transition.when))
        .map(async (transition) => {
          const routeDecision = await resolveStepAgent(transition, router);
          await traceLog.record(rootTask.id, {
            at: new Date().toISOString(),
            kind: "routing.selected",
            payload: {
              fromStepId: completedStep.id,
              stepName: transition.createStep.stepName,
              taskKind: transition.createStep.taskKind,
              selectedAgentId: routeDecision.selectedAgentId,
              reason: routeDecision.reason,
            },
          });

          return {
            stepName: transition.createStep.stepName,
            agentId: routeDecision.selectedAgentId,
            workflowNodeId: transition.createStep.workflowNodeId,
            parentStepId: completedStep.id,
            dependsOn: [completedStep.id],
            input: buildStepInput(
              event.output,
              transition.createStep.input,
              transition.createStep.inputFromOutputPath,
              transition.createStep.taskKind,
              routeDecision.selectedAgentId,
              agentCardRegistry.get(routeDecision.selectedAgentId),
            ),
          };
        }));

      if (nextSteps.length > 0) {
        return { nextSteps };
      }

      return {
        completeRoot: {
          finalOutput: unwrapFinalOutput(event.output),
        },
      };
    },
  };

  const orchestrator = new A2AOrchestrator(taskStore, eventBus, workflowPlanner);
  orchestrator.start();

  for (const [agentId, runtime] of runtimes.entries()) {
    const agentCard = agentCardRegistry.get(agentId);
    const worker = new StepWorkerRuntime(
      agentId,
      eventBus,
      async (input) => {
        const stepInput = normalizeStepInput(input, config, agentId, agentCard);
        const result = await runtime.ask(stepInput);
        return {
          output: parseStructuredAgentOutput(result.output),
        };
      },
      artifactStore,
    );
    worker.start();
  }

  eventBus.subscribeEvents(async (event) => {
    await traceLog.record(event.rootTaskId, {
      at: event.at,
      kind: `event.${event.type}`,
      payload: event,
    });
  });

  return {
    async createTask(body) {
      const request = normalizeCreateTaskRequest(body, config.defaultAgentId);
      return createTaskFromSpec(request, orchestrator, router, traceLog);
    },
    async planAndCreateTask(userRequest) {
      const planned = await taskPlanner.plan(userRequest);
      await traceLog.record("planner", {
        at: new Date().toISOString(),
        kind: "planner.output",
        payload: {
          userRequest,
          planned,
        },
      });
      return createTaskFromSpec(planned, orchestrator, router, traceLog);
    },
    getTask(rootTaskId) {
      return taskStore.getRootTask(rootTaskId);
    },
    listTasks() {
      return taskStore.listRootTasks();
    },
    async listSteps(rootTaskId) {
      const rootTask = await taskStore.getRootTask(rootTaskId);
      if (!rootTask) {
        return undefined;
      }
      return taskStore.listStepTasks(rootTaskId);
    },
    async listEvents(rootTaskId) {
      const rootTask = await taskStore.getRootTask(rootTaskId);
      if (!rootTask) {
        return undefined;
      }
      return taskStore.listStepEvents(rootTaskId);
    },
  };
}

function requireAgentModelConfig(agentId: string, config: RuntimeConfig) {
  const agent = config.agents.find((item) => item.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" is not configured.`);
  }
  return agent.model;
}

function normalizeCreateTaskRequest(
  body: Record<string, unknown>,
  defaultAgentId: string,
): A2ATaskCreateRequest {
  const initialStepValue = body.initialStep;
  if (!initialStepValue || typeof initialStepValue !== "object") {
    throw new Error('Field "initialStep" is required.');
  }

  const record = initialStepValue as Record<string, unknown>;
  const stepName = typeof record.stepName === "string" && record.stepName.trim()
    ? record.stepName.trim()
    : undefined;
  const agentId = typeof record.agentId === "string" && record.agentId.trim()
    ? record.agentId.trim()
    : undefined;
  const taskKind = typeof record.taskKind === "string" && record.taskKind.trim()
    ? record.taskKind.trim()
    : undefined;

  if (!stepName) {
    throw new Error('Field "initialStep.stepName" is required.');
  }
  if (!agentId && !taskKind) {
    return {
      input: body.input,
      workflow: normalizeWorkflowDefinition(body.workflow),
      initialStep: {
        stepName,
        agentId: defaultAgentId,
        workflowNodeId: typeof record.workflowNodeId === "string" && record.workflowNodeId.trim()
          ? record.workflowNodeId.trim()
          : undefined,
        input: record.input ?? body.input ?? "",
      },
    };
  }

  return {
    input: body.input,
    workflow: normalizeWorkflowDefinition(body.workflow),
    initialStep: {
      stepName,
      ...(agentId ? { agentId } : {}),
      ...(taskKind ? { taskKind } : {}),
      workflowNodeId: typeof record.workflowNodeId === "string" && record.workflowNodeId.trim()
        ? record.workflowNodeId.trim()
        : undefined,
      input: record.input ?? body.input ?? "",
    },
  };
}

async function createTaskFromSpec(
  request: A2ATaskCreateRequest,
  orchestrator: A2AOrchestrator,
  router: ModelBasedAgentRouter,
  traceLog: FileBackedA2ATraceLog,
) {
  const initialRoute = await resolveInitialStepAgent(request.initialStep, router);
  const created = await orchestrator.startRootTask({
    input: {
      ...(request.input !== undefined ? { input: request.input } : {}),
      ...(request.workflow ? { workflow: request.workflow } : {}),
    },
    initialStep: {
      stepName: request.initialStep.stepName,
      agentId: initialRoute.selectedAgentId,
      workflowNodeId: request.initialStep.workflowNodeId,
      input: injectInitialTaskKind(request.initialStep.input, request.initialStep.taskKind, initialRoute.selectedAgentId),
    },
  });
  await traceLog.record(created.rootTask.id, {
    at: new Date().toISOString(),
    kind: "task.created",
    payload: {
      rootTaskId: created.rootTask.id,
      initialStepId: created.initialStep.id,
      initialStep: request.initialStep,
      selectedAgentId: initialRoute.selectedAgentId,
      routingReason: initialRoute.reason,
    },
  });
  return {
    ok: true as const,
    rootTaskId: created.rootTask.id,
    status: created.rootTask.status,
    initialStepId: created.initialStep.id,
  };
}

async function resolveInitialStepAgent(
  step: NormalizedInitialStep,
  router: ModelBasedAgentRouter,
): Promise<{ selectedAgentId: string; reason: string }> {
  if (step.agentId) {
    return {
      selectedAgentId: step.agentId,
      reason: `Initial step explicitly selected "${step.agentId}".`,
    };
  }
  if (!step.taskKind) {
    throw new Error(`Initial step "${step.stepName}" must declare agentId or taskKind.`);
  }
  return router.route({
    taskKind: step.taskKind,
    input: step.input,
  });
}

function injectInitialTaskKind(input: unknown, taskKind: string | undefined, selectedAgentId: string): unknown {
  if (!taskKind) {
    return input;
  }
  if (typeof input === "string") {
    return {
      userRequest: input,
      taskKind,
      assignedAgentId: selectedAgentId,
    };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return {
      ...(input as Record<string, unknown>),
      taskKind,
      assignedAgentId: selectedAgentId,
    };
  }
  return {
    taskKind,
    assignedAgentId: selectedAgentId,
    payload: input,
    userRequest: `Execute initial task of kind "${taskKind}".`,
  };
}

function normalizeWorkflowDefinition(value: unknown): TaskWorkflowDefinition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const transitions = Array.isArray(record.transitions)
    ? record.transitions
      .map((item) => normalizeWorkflowTransition(item))
      .filter((item): item is TaskWorkflowTransition => item !== undefined)
    : undefined;
  return { transitions };
}

function normalizeWorkflowTransition(value: unknown): TaskWorkflowTransition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const createStepValue = record.createStep;
  if (typeof record.on !== "string" || !record.on.trim() || !createStepValue || typeof createStepValue !== "object") {
    return undefined;
  }
  const createStep = createStepValue as Record<string, unknown>;
  if (
    typeof createStep.stepName !== "string"
    || !createStep.stepName.trim()
    || !(
      (typeof createStep.agentId === "string" && createStep.agentId.trim())
      || (typeof createStep.taskKind === "string" && createStep.taskKind.trim())
    )
  ) {
    return undefined;
  }
  const whenValue = record.when;
  const when = whenValue && typeof whenValue === "object" && typeof (whenValue as Record<string, unknown>).path === "string"
    ? {
      path: String((whenValue as Record<string, unknown>).path),
      equals: (whenValue as Record<string, unknown>).equals,
    }
    : undefined;

  return {
    on: record.on.trim(),
    when,
    createStep: {
      stepName: createStep.stepName.trim(),
      agentId: typeof createStep.agentId === "string" && createStep.agentId.trim() ? createStep.agentId.trim() : undefined,
      taskKind: typeof createStep.taskKind === "string" && createStep.taskKind.trim() ? createStep.taskKind.trim() : undefined,
      goal: typeof createStep.goal === "string" && createStep.goal.trim() ? createStep.goal.trim() : undefined,
      requiredCapabilities: Array.isArray(createStep.requiredCapabilities)
        ? createStep.requiredCapabilities.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : undefined,
      workflowNodeId: typeof createStep.workflowNodeId === "string" && createStep.workflowNodeId.trim() ? createStep.workflowNodeId.trim() : undefined,
      input: createStep.input,
      inputFromOutputPath: typeof createStep.inputFromOutputPath === "string" && createStep.inputFromOutputPath.trim()
        ? createStep.inputFromOutputPath.trim()
        : undefined,
    },
  };
}

function normalizeStepInput(input: unknown, config: RuntimeConfig, agentId: string, agentCard?: AgentCard) {
  if (typeof input === "string") {
    return {
      userRequest: buildWorkerPrompt(input, undefined, agentCard),
      agentId,
      sessionId: `task-${Date.now()}`,
      projectId: config.workspaceRoot,
    };
  }
  if (!input || typeof input !== "object") {
    throw new Error("Step input must be a string or object.");
  }
  const record = input as Record<string, unknown>;
  const userRequest = typeof record.userRequest === "string" && record.userRequest.trim()
    ? record.userRequest.trim()
    : typeof record.prompt === "string" && record.prompt.trim()
      ? record.prompt.trim()
      : undefined;
  if (!userRequest) {
    throw new Error('Step input must include "userRequest" or "prompt".');
  }
  return {
    userRequest: buildWorkerPrompt(userRequest, {
      taskKind: typeof record.taskKind === "string" && record.taskKind.trim() ? record.taskKind.trim() : undefined,
      payload: record.payload,
    }, agentCard),
    history: normalizeHistory(record.history),
    sessionId: typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : `task-${Date.now()}`,
    userId: typeof record.userId === "string" && record.userId.trim() ? record.userId.trim() : undefined,
    agentId,
    channelId: typeof record.channelId === "string" && record.channelId.trim() ? record.channelId.trim() : undefined,
    projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : config.workspaceRoot,
  };
}

function parseStructuredAgentOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return output;
  }
}

function normalizeHistory(value: unknown): AgentMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const history = value
    .map((item) => normalizeAgentMessage(item))
    .filter((item): item is AgentMessage => item !== undefined);
  return history.length > 0 ? history : undefined;
}

function normalizeAgentMessage(value: unknown): AgentMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.role !== "string" || typeof record.content !== "string") {
    return undefined;
  }
  if (!["system", "developer", "user", "assistant", "tool"].includes(record.role)) {
    return undefined;
  }
  return {
    role: record.role as AgentMessage["role"],
    content: record.content,
    ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
  };
}

async function resolveStepAgent(transition: TaskWorkflowTransition, router: ModelBasedAgentRouter) {
  if (transition.createStep.agentId) {
    return {
      selectedAgentId: transition.createStep.agentId,
      reason: `Workflow transition explicitly selected "${transition.createStep.agentId}".`,
    };
  }
  if (!transition.createStep.taskKind) {
    throw new Error(`Workflow step "${transition.createStep.stepName}" must declare agentId or taskKind.`);
  }
  return router.route({
    taskKind: transition.createStep.taskKind,
    goal: transition.createStep.goal,
    requiredCapabilities: transition.createStep.requiredCapabilities,
    input: transition.createStep.input,
  });
}

function readWorkflow(rootTask: RootTask): TaskWorkflowDefinition {
  if (!rootTask.input || typeof rootTask.input !== "object") {
    return {};
  }
  return normalizeWorkflowDefinition((rootTask.input as Record<string, unknown>).workflow) ?? {};
}

function matchesCondition(output: unknown, condition: TaskWorkflowTransition["when"]): boolean {
  if (!condition) {
    return true;
  }
  return Object.is(readPath(output, condition.path), condition.equals);
}

function buildStepInput(
  output: unknown,
  staticInput: unknown,
  inputFromOutputPath: string | undefined,
  taskKind: string | undefined,
  selectedAgentId: string,
  agentCard: AgentCard | undefined,
): unknown {
  const merged = mergeInput(output, staticInput, inputFromOutputPath);
  if (typeof merged === "string") {
    return { userRequest: merged, taskKind, assignedAgentId: selectedAgentId };
  }
  if (isRecord(merged)) {
    return {
      ...merged,
      ...(taskKind ? { taskKind } : {}),
      assignedAgentId: selectedAgentId,
      ...(agentCard ? { assignedAgentDescription: agentCard.description } : {}),
    };
  }
  return {
    taskKind,
    assignedAgentId: selectedAgentId,
    payload: merged,
    userRequest: typeof merged === "undefined"
      ? `Execute assigned task${taskKind ? ` of kind "${taskKind}"` : ""}.`
      : `Execute assigned task${taskKind ? ` of kind "${taskKind}"` : ""} using the provided payload.`,
  };
}

function mergeInput(output: unknown, staticInput: unknown, inputFromOutputPath?: string): unknown {
  const dynamicInput = inputFromOutputPath ? readPath(output, inputFromOutputPath) : undefined;
  if (isRecord(staticInput) && isRecord(dynamicInput)) {
    return { ...staticInput, ...dynamicInput };
  }
  if (dynamicInput !== undefined) {
    return dynamicInput;
  }
  return staticInput;
}

function unwrapFinalOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }
  return "finalOutput" in output ? output.finalOutput : output;
}

function readPath(value: unknown, pathExpression: string): unknown {
  return pathExpression.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildWorkerPrompt(
  userRequest: string,
  assignment: { taskKind?: string; payload?: unknown } | undefined,
  agentCard?: AgentCard,
): string {
  const parts = [];
  if (agentCard) {
    parts.push([
      "[Assigned Agent Card]",
      `agentId: ${agentCard.agentId}`,
      `description: ${agentCard.description}`,
      `taskKinds: ${agentCard.taskKinds.join(", ") || "(none)"}`,
      `capabilities: ${agentCard.capabilities.join(", ") || "(none)"}`,
    ].join("\n"));
  }
  if (assignment?.taskKind || assignment?.payload !== undefined) {
    parts.push([
      "[Assignment]",
      assignment.taskKind ? `taskKind: ${assignment.taskKind}` : undefined,
      assignment.payload !== undefined ? `payload: ${JSON.stringify(assignment.payload, null, 2)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n"));
  }
  parts.push(userRequest);
  return parts.join("\n\n");
}
