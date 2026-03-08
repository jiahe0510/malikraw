import type { AgentMessage } from "../core/agent/types.js";
import type { ToolResultEnvelope } from "../core/tool-registry/types.js";

export type MemoryScope = "session" | "project" | "global";
export type MemoryItemType = "semantic" | "episode";
export type MemorySource = "user_explicit" | "inferred" | "task_summary";
export type ExtractedMemorySource = "explicit" | "inferred";

export type SessionTaskState = {
  goal?: string;
  currentPlan: string[];
  completedSteps: string[];
  openQuestions: string[];
  status: "active" | "completed";
  updatedAt: string;
};

export type SessionMemoryState = {
  recentMessages: AgentMessage[];
  taskState: SessionTaskState;
};

export type SessionStateRecord = {
  sessionId: string;
  userId: string;
  agentId: string;
  projectId?: string;
  state: SessionMemoryState;
  updatedAt: string;
};

export type SemanticMemoryRecord = {
  id: string;
  userId: string;
  agentId: string;
  scope: MemoryScope;
  key: string;
  summary: string;
  value: string | boolean | number;
  confidence: number;
  importance: number;
  source: MemorySource;
  content: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type EpisodicMemoryRecord = {
  id: string;
  userId: string;
  agentId: string;
  scope: MemoryScope;
  summary: string;
  entities: string[];
  importance: number;
  confidence: number;
  source: MemorySource;
  content: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
};

export type SemanticMemoryCandidate = {
  key: string;
  value: string | boolean | number;
  scope: MemoryScope;
  confidence: number;
  source: ExtractedMemorySource;
  summary: string;
};

export type EpisodicMemoryCandidate = {
  summary: string;
  entities: string[];
  importance: number;
  confidence?: number;
};

export type ExtractedMemory = {
  semantic: SemanticMemoryCandidate[];
  episode?: EpisodicMemoryCandidate;
};

export type MemoryContext = {
  sessionId: string;
  userId: string;
  agentId: string;
  projectId?: string;
  channelId?: string;
};

export type MemoryWriteInput = {
  context: MemoryContext;
  userMessage: string;
  assistantResponse: string;
  toolResults: ToolResultEnvelope[];
  sessionMessages: AgentMessage[];
  currentTaskState?: SessionTaskState;
};

export type MemoryRetrieveInput = {
  context: MemoryContext;
  query: string;
};

export type RetrievedMemory = {
  sessionState?: SessionStateRecord;
  semantic: SemanticMemoryRecord[];
  episodes: EpisodicMemoryRecord[];
  compiledBlock: string;
  observations: MemoryObservations;
};

export type MemoryObservations = {
  semanticWritten: number;
  episodesWritten: number;
  semanticRetrieved: number;
  episodesRetrieved: number;
  compiledChars: number;
  estimatedTokens: number;
};

export type MemoryWriteResult = {
  sessionState: SessionStateRecord;
  semanticWritten: number;
  episodeWritten: boolean;
  observations: MemoryObservations;
};

export type MemoryConfig = {
  enabled: boolean;
  postgresUrl?: string;
  redisUrl?: string;
  embeddingModel?: string;
  embeddingDimensions: number;
  sessionRecentMessages: number;
  semanticTopK: number;
  episodicTopK: number;
  maxPromptChars: number;
  importanceThreshold: number;
};

export interface SessionStateStore {
  read(context: MemoryContext): Promise<SessionStateRecord | undefined>;
  write(record: SessionStateRecord): Promise<void>;
}

export interface SemanticMemoryStore {
  upsertMany(
    context: MemoryContext,
    items: SemanticMemoryCandidate[],
  ): Promise<number>;
  listRelevant(
    context: MemoryContext,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<SemanticMemoryRecord[]>;
}

export interface EpisodicMemoryStore {
  insert(
    context: MemoryContext,
    episode: EpisodicMemoryCandidate,
    embedding?: number[],
  ): Promise<void>;
  searchRelevant(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
      embedding?: number[];
    },
  ): Promise<EpisodicMemoryRecord[]>;
}

export interface MemoryEmbedder {
  embed(input: string): Promise<number[]>;
}

export interface SemanticExtractor {
  extract(input: MemoryWriteInput): Promise<SemanticMemoryCandidate[]>;
}

export interface EpisodeExtractor {
  extract(input: MemoryWriteInput): Promise<EpisodicMemoryCandidate | undefined>;
}

export interface MemoryService {
  retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory>;
  write(input: MemoryWriteInput): Promise<MemoryWriteResult>;
}
