import type { AgentMessage } from "../core/agent/types.js";
import type {
  AgentCard,
  AgentCardRegistry,
  AgentRouter,
  RouteDecision,
  RouteTaskRequest,
  RouterModelFactory,
} from "./agent-card.js";

export class ModelBasedAgentRouter implements AgentRouter {
  constructor(
    private readonly registry: AgentCardRegistry,
    private readonly modelFactory: RouterModelFactory,
    private readonly routerAgentId = "main",
  ) {}

  async route(request: RouteTaskRequest): Promise<RouteDecision> {
    if (request.preferredAgentId) {
      const preferred = this.registry.get(request.preferredAgentId);
      if (preferred) {
        return {
          selectedAgentId: preferred.agentId,
          reason: `Preferred agent "${preferred.agentId}" was explicitly requested.`,
        };
      }
    }

    const candidates = rankCandidates(this.registry.list(), request);
    if (candidates.length === 0) {
      throw new Error(`No candidate agent for taskKind="${request.taskKind}".`);
    }

    const exactMatches = candidates.filter((candidate) => candidate.score === candidates[0]?.score);
    if (exactMatches.length === 1) {
      return {
        selectedAgentId: exactMatches[0].card.agentId,
        reason: `Rule-based routing selected "${exactMatches[0].card.agentId}" for taskKind="${request.taskKind}".`,
      };
    }

    const model = this.modelFactory(this.routerAgentId);
    const response = await model.generate({
      messages: buildRoutingPrompt(request, exactMatches.map((candidate) => candidate.card)),
      tools: [],
    });

    if (response.type !== "final") {
      throw new Error("Router model returned tool calls, but routing requires a final JSON response.");
    }

    return parseRoutingDecision(response.outputText, exactMatches.map((candidate) => candidate.card));
  }
}

function buildRoutingPrompt(request: RouteTaskRequest, candidates: AgentCard[]): AgentMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the workflow router for an async multi-agent system.",
        "Each candidate agent card includes agentId, description, taskKinds, capabilities, and constraints.",
        "Choose exactly one agent from the candidates.",
        "Return strict JSON only.",
        'Schema: {"selectedAgentId":"string","reason":"string"}',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: request,
        candidates,
      }, null, 2),
    },
  ];
}

function parseRoutingDecision(output: string, candidates: AgentCard[]): RouteDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Router returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Router returned an invalid decision payload.");
  }

  const record = parsed as Record<string, unknown>;
  const selectedAgentId = typeof record.selectedAgentId === "string" ? record.selectedAgentId.trim() : "";
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";

  if (!selectedAgentId) {
    throw new Error("Router decision is missing selectedAgentId.");
  }

  if (!candidates.some((candidate) => candidate.agentId === selectedAgentId)) {
    throw new Error(`Router selected unknown agent "${selectedAgentId}".`);
  }

  return {
    selectedAgentId,
    reason: reason || `Model-based routing selected "${selectedAgentId}".`,
  };
}

function rankCandidates(cards: AgentCard[], request: RouteTaskRequest) {
  return cards
    .map((card) => ({
      card,
      score: scoreAgent(card, request),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.card.agentId.localeCompare(right.card.agentId));
}

function scoreAgent(card: AgentCard, request: RouteTaskRequest): number {
  let score = 0;

  if (card.taskKinds.includes(request.taskKind)) {
    score += 10;
  }

  for (const capability of request.requiredCapabilities ?? []) {
    if (card.capabilities.includes(capability)) {
      score += 3;
    }
  }

  if (score === 0 && request.requiredCapabilities && request.requiredCapabilities.length > 0) {
    return 0;
  }

  return score;
}
