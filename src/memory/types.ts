import type { ToolResultEnvelope } from "../core/tool-registry/types.js";

export type MemoryScope = "session" | "project" | "global";
export type MemoryItemType = "semantic" | "episode";
export type MemorySource = "user_explicit" | "inferred" | "task_summary" | "history_compaction";
export type ExtractedMemorySource = "explicit" | "inferred";

export type SessionMemoryState = {
  handoff: string[];
  notes: string[];
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
  createdAt: string;
  updatedAt: string;
};

export type QueryMemoryItemRecord = {
  id: string;
  userId: string;
  agentId: string;
  scope: MemoryScope;
  query: string;
  summary: string;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
};

export type QueryMemoryItemCandidate = {
  query: string;
  summary: string;
  content: string;
  scope: MemoryScope;
  importance: number;
  confidence: number;
  source: MemorySource;
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
  source?: MemorySource;
  content?: Record<string, unknown>;
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
  traceId?: string;
};

export type MemoryWriteInput = {
  context: MemoryContext;
  trigger: "compaction" | "explicit_memory";
  userMessage: string;
  assistantResponse: string;
  toolResults: ToolResultEnvelope[];
  compaction?: {
    summary: string;
    messagesCompacted: number;
    estimatedTokens: number;
  };
};

export type ToolChainStep = {
  toolName: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  data?: unknown;
  error?: unknown;
};

export type ToolChainMemoryRecord = {
  id: string;
  userId: string;
  agentId: string;
  sessionId: string;
  projectId?: string;
  query: string;
  assistantResponse: string;
  toolChain: ToolChainStep[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryRetrieveInput = {
  context: MemoryContext;
  query: string;
};

export type RetrievedMemory = {
  sessionState?: SessionStateRecord;
  memoryItems: QueryMemoryItemRecord[];
  toolChains: ToolChainMemoryRecord[];
  compiledBlock: string;
  observations: MemoryObservations;
};

export type MemoryObservations = {
  memoryItemsWritten: number;
  toolChainsWritten: number;
  memoryItemsRetrieved: number;
  toolChainsRetrieved: number;
  compiledChars: number;
  estimatedTokens: number;
};

export type MemoryWriteResult = {
  sessionState?: SessionStateRecord;
  memoryItemsWritten: number;
  toolChainsWritten: number;
  observations: MemoryObservations;
};

export type MemoryConfig = Record<string, never>;

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
  ): Promise<void>;
  searchRelevant(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
    },
  ): Promise<EpisodicMemoryRecord[]>;
}

export interface MemoryItemStore {
  insert(
    context: MemoryContext,
    item: QueryMemoryItemCandidate,
  ): Promise<void>;
  searchRelevant(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
    },
  ): Promise<QueryMemoryItemRecord[]>;
}

export interface ToolChainMemoryStore {
  insert(
    context: MemoryContext,
    input: {
      query: string;
      assistantResponse: string;
      toolChain: ToolChainStep[];
    },
  ): Promise<void>;
  searchRelevant(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
    },
  ): Promise<ToolChainMemoryRecord[]>;
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
