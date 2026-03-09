import type { AgentModel } from "../core/agent/types.js";

export type AgentCard = {
  agentId: string;
  description: string;
  taskKinds: string[];
  capabilities: string[];
  constraints?: {
    maxDurationSec?: number;
    maxInputChars?: number;
    costTier?: "low" | "medium" | "high";
  };
};

export interface AgentCardRegistry {
  list(): AgentCard[];
  get(agentId: string): AgentCard | undefined;
}

export class InMemoryAgentCardRegistry implements AgentCardRegistry {
  private readonly cardsById: Map<string, AgentCard>;

  constructor(cards: AgentCard[]) {
    this.cardsById = new Map(cards.map((card) => [card.agentId, card]));
  }

  list(): AgentCard[] {
    return [...this.cardsById.values()];
  }

  get(agentId: string): AgentCard | undefined {
    return this.cardsById.get(agentId);
  }
}

export type RouteTaskRequest = {
  taskKind: string;
  goal?: string;
  requiredCapabilities?: string[];
  input?: unknown;
  preferredAgentId?: string;
};

export type RouteDecision = {
  selectedAgentId: string;
  reason: string;
};

export interface AgentRouter {
  route(request: RouteTaskRequest): Promise<RouteDecision>;
}

export type RouterModelFactory = (agentId: string) => AgentModel;
