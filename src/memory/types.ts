import type { ToolResultEnvelope } from "../core/tool-registry/types.js";

export type MemoryScope = "session" | "project" | "global";
export type MemoryLayer = "stm" | "ltm";
export type MemoryStatus =
  | "active"
  | "cooling"
  | "consolidated"
  | "suppressed"
  | "repressed"
  | "archived"
  | "invalidated";
export type MemoryArtifactType =
  | "session_snapshot"
  | "session_note"
  | "semantic"
  | "episodic"
  | "procedural"
  | "relational"
  | "affective"
  | "repressed"
  | "symptom"
  | "conflict";
export type MemorySource = "user_explicit" | "inferred" | "task_summary" | "history_compaction";
export type ExtractedMemorySource = "explicit" | "inferred";

export type MemorySourceRef = {
  kind: "conversation" | "compaction" | "tool_chain" | "reflection";
  sessionId?: string;
  userId?: string;
  agentId?: string;
  projectId?: string;
  turnIds?: Array<string | number>;
  trigger?: "compaction" | "explicit_memory";
};

export type MemoryFrontmatterFields = {
  memoryType?: MemoryArtifactType;
  layer?: MemoryLayer;
  status?: MemoryStatus;
  salience?: number;
  valence?: number;
  arousal?: number;
  retrievalWeight?: number;
  repressionScore?: number;
  linkedMemories?: string[];
  screenFor?: string[];
  triggerCues?: string[];
  consolidationState?: "pending" | "merged" | "promoted" | "archived" | "discarded";
  version?: number;
  sourceRef?: MemorySourceRef;
  tags?: string[];
  entities?: string[];
};

export type SessionMemoryState = {
  handoff: string[];
  notes: string[];
};

export type SessionStateRecord = MemoryFrontmatterFields & {
  sessionId: string;
  userId: string;
  agentId: string;
  projectId?: string;
  state: SessionMemoryState;
  updatedAt: string;
};

export type MemoryArtifactFamily = "knowledge" | "procedural";

type BaseMemoryArtifactRecord = MemoryFrontmatterFields & {
  id: string;
  userId: string;
  agentId: string;
  family: MemoryArtifactFamily;
  query: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeArtifactRecord = BaseMemoryArtifactRecord & {
  family: "knowledge";
  scope: MemoryScope;
  summary: string;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
};

export type KnowledgeArtifactCandidate = {
  query: string;
  summary: string;
  content: string;
  scope: MemoryScope;
  importance: number;
  confidence: number;
  source: MemorySource;
} & MemoryFrontmatterFields;

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

export type MemoryRetrieveMode = "normal" | "analytic";
export type MemoryUsageTier = "fact" | "pattern" | "hypothesis";

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

export type ProceduralArtifactRecord = BaseMemoryArtifactRecord & {
  family: "procedural";
  sessionId: string;
  projectId?: string;
  assistantResponse: string;
  toolChain: ToolChainStep[];
};

export type ProceduralArtifactCandidate = {
  query: string;
  assistantResponse: string;
  toolChain: ToolChainStep[];
} & MemoryFrontmatterFields;

export type MemoryArtifactRecord = KnowledgeArtifactRecord | ProceduralArtifactRecord;

export type MemoryRetrieveInput = {
  context: MemoryContext;
  query: string;
  mode?: MemoryRetrieveMode;
};

export type RetrievedMemory = {
  sessionState?: SessionStateRecord;
  knowledgeArtifacts: KnowledgeArtifactRecord[];
  proceduralArtifacts: ProceduralArtifactRecord[];
  compiledBlock: string;
  mode: MemoryRetrieveMode;
  observations: MemoryObservations;
};

export type MemoryObservations = {
  knowledgeArtifactsWritten: number;
  proceduralArtifactsWritten: number;
  knowledgeArtifactsRetrieved: number;
  proceduralArtifactsRetrieved: number;
  compiledChars: number;
  estimatedTokens: number;
};

export type MemoryWriteResult = {
  sessionState?: SessionStateRecord;
  knowledgeArtifactsWritten: number;
  proceduralArtifactsWritten: number;
  observations: MemoryObservations;
};

export type MemoryConfig = Record<string, never>;

export interface SessionStateStore {
  read(context: MemoryContext): Promise<SessionStateRecord | undefined>;
  write(record: SessionStateRecord): Promise<void>;
}

export interface ArtifactStore {
  insertKnowledge(
    context: MemoryContext,
    artifact: KnowledgeArtifactCandidate,
  ): Promise<void>;
  insertProcedural(
    context: MemoryContext,
    artifact: ProceduralArtifactCandidate,
  ): Promise<void>;
  searchKnowledge(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
    },
  ): Promise<KnowledgeArtifactRecord[]>;
  searchProcedural(
    context: MemoryContext,
    query: string,
    options: {
      limit: number;
    },
  ): Promise<ProceduralArtifactRecord[]>;
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
