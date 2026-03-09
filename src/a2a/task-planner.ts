import type { AgentMessage, AgentModel } from "../core/agent/types.js";
import type { AgentCard } from "./agent-card.js";

export type PlannedTaskStep = {
  stepName: string;
  agentId?: string;
  taskKind?: string;
  workflowNodeId?: string;
  input: unknown;
};

export type PlannedTaskTransition = {
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

export type PlannedTaskSpec = {
  input: {
    query: string;
  };
  initialStep: PlannedTaskStep;
  workflow?: {
    transitions?: PlannedTaskTransition[];
  };
};

export class ModelBasedTaskPlanner {
  constructor(
    private readonly model: AgentModel,
    private readonly options: {
      workspaceRoot: string;
      agentCards: AgentCard[];
    },
  ) {}

  async plan(userRequest: string): Promise<PlannedTaskSpec> {
    const response = await this.model.generate({
      messages: buildPlannerPrompt(userRequest, this.options.workspaceRoot, this.options.agentCards),
      tools: [],
    });

    if (response.type !== "final") {
      throw new Error("Task planner returned tool calls, but planning requires strict JSON.");
    }

    return parsePlannedTaskSpec(response.outputText);
  }
}

function buildPlannerPrompt(userRequest: string, workspaceRoot: string, agentCards: AgentCard[]): AgentMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the task planner for an async multi-agent orchestration system.",
        "Convert the user's natural-language request into a strict JSON task spec.",
        "Use the provided agent cards to choose taskKind or agentId for steps.",
        "Prefer taskKind over agentId unless the request requires a specific agent.",
        "Design a minimal workflow. Only add transitions when a later step depends on an earlier result.",
        "The initial step input should usually include a userRequest string instructing the worker to return strict JSON when downstream routing depends on structured fields.",
        "Return JSON only.",
        "Schema:",
        JSON.stringify({
          input: { query: "string" },
          initialStep: {
            stepName: "string",
            agentId: "string optional",
            taskKind: "string optional",
            workflowNodeId: "string optional",
            input: "unknown",
          },
          workflow: {
            transitions: [
              {
                on: "string",
                when: {
                  path: "string optional",
                  equals: "unknown optional",
                },
                createStep: {
                  stepName: "string",
                  agentId: "string optional",
                  taskKind: "string optional",
                  goal: "string optional",
                  requiredCapabilities: ["string optional"],
                  workflowNodeId: "string optional",
                  input: "unknown optional",
                  inputFromOutputPath: "string optional",
                },
              },
            ],
          },
        }, null, 2),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        workspaceRoot,
        agentCards,
        userRequest,
      }, null, 2),
    },
  ];
}

function parsePlannedTaskSpec(output: string): PlannedTaskSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Task planner returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Task planner returned an invalid task spec.");
  }

  const record = parsed as Record<string, unknown>;
  const input = record.input;
  const initialStep = record.initialStep;
  if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).query !== "string") {
    throw new Error("Task planner spec is missing input.query.");
  }
  if (!initialStep || typeof initialStep !== "object") {
    throw new Error("Task planner spec is missing initialStep.");
  }

  const normalizedInitialStep = normalizePlannedStep(initialStep);
  const workflow = normalizeWorkflow(record.workflow);

  return {
    input: {
      query: String((input as Record<string, unknown>).query),
    },
    initialStep: normalizedInitialStep,
    ...(workflow ? { workflow } : {}),
  };
}

function normalizePlannedStep(value: unknown): PlannedTaskStep {
  if (!value || typeof value !== "object") {
    throw new Error("Planned step is invalid.");
  }
  const record = value as Record<string, unknown>;
  const stepName = typeof record.stepName === "string" ? record.stepName.trim() : "";
  const agentId = typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : undefined;
  const taskKind = typeof record.taskKind === "string" && record.taskKind.trim() ? record.taskKind.trim() : undefined;
  const input = "input" in record ? record.input : "";

  if (!stepName) {
    throw new Error("Planned step is missing stepName.");
  }
  if (!agentId && !taskKind) {
    throw new Error("Planned step must include agentId or taskKind.");
  }

  return {
    stepName,
    ...(agentId ? { agentId } : {}),
    ...(taskKind ? { taskKind } : {}),
    ...(typeof record.workflowNodeId === "string" && record.workflowNodeId.trim()
      ? { workflowNodeId: record.workflowNodeId.trim() }
      : {}),
    input,
  };
}

function normalizeWorkflow(value: unknown): PlannedTaskSpec["workflow"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const transitionsValue = (value as Record<string, unknown>).transitions;
  if (!Array.isArray(transitionsValue)) {
    return undefined;
  }

  const transitions = transitionsValue.map((item) => normalizeTransition(item)).filter((item): item is PlannedTaskTransition => item !== undefined);
  return transitions.length > 0 ? { transitions } : undefined;
}

function normalizeTransition(value: unknown): PlannedTaskTransition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const on = typeof record.on === "string" ? record.on.trim() : "";
  const createStep = record.createStep;
  if (!on || !createStep || typeof createStep !== "object") {
    return undefined;
  }

  const normalizedStep = normalizeTransitionCreateStep(createStep);
  if (!normalizedStep) {
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
    on,
    ...(when ? { when } : {}),
    createStep: normalizedStep,
  };
}

function normalizeTransitionCreateStep(value: unknown): PlannedTaskTransition["createStep"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stepName = typeof record.stepName === "string" ? record.stepName.trim() : "";
  const agentId = typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : undefined;
  const taskKind = typeof record.taskKind === "string" && record.taskKind.trim() ? record.taskKind.trim() : undefined;
  if (!stepName || (!agentId && !taskKind)) {
    return undefined;
  }

  return {
    stepName,
    ...(agentId ? { agentId } : {}),
    ...(taskKind ? { taskKind } : {}),
    ...(typeof record.goal === "string" && record.goal.trim() ? { goal: record.goal.trim() } : {}),
    ...(Array.isArray(record.requiredCapabilities)
      ? { requiredCapabilities: record.requiredCapabilities.filter((item): item is string => typeof item === "string" && item.trim().length > 0) }
      : {}),
    ...(typeof record.workflowNodeId === "string" && record.workflowNodeId.trim() ? { workflowNodeId: record.workflowNodeId.trim() } : {}),
    ...("input" in record ? { input: record.input } : {}),
    ...(typeof record.inputFromOutputPath === "string" && record.inputFromOutputPath.trim()
      ? { inputFromOutputPath: record.inputFromOutputPath.trim() }
      : {}),
  };
}
