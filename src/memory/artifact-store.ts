import { randomUUID } from "node:crypto";

import { recordRuntimeObservation } from "../core/observability/observability.js";
import {
  appendIndexedKnowledgeArtifact,
  appendIndexedProceduralArtifact,
  loadIndexedKnowledgeArtifacts,
  loadIndexedProceduralArtifacts,
} from "./manifest-store.js";
import { writeKnowledgeArtifactMarkdown, writeProceduralArtifactMarkdown } from "./markdown-store.js";
import type {
  ArtifactStore,
  KnowledgeArtifactCandidate,
  KnowledgeArtifactRecord,
  MemoryContext,
  ProceduralArtifactCandidate,
  ProceduralArtifactRecord,
} from "./types.js";

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly knowledgeRecords: KnowledgeArtifactRecord[] = [];
  private readonly proceduralRecords: ProceduralArtifactRecord[] = [];

  async insertKnowledge(context: MemoryContext, artifact: KnowledgeArtifactCandidate): Promise<void> {
    const now = new Date().toISOString();
    this.knowledgeRecords.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      family: "knowledge",
      memoryType: artifact.memoryType,
      layer: artifact.layer,
      status: artifact.status,
      salience: artifact.salience,
      valence: artifact.valence,
      arousal: artifact.arousal,
      retrievalWeight: artifact.retrievalWeight,
      repressionScore: artifact.repressionScore,
      linkedMemories: artifact.linkedMemories,
      screenFor: artifact.screenFor,
      triggerCues: artifact.triggerCues,
      consolidationState: artifact.consolidationState,
      version: artifact.version,
      sourceRef: artifact.sourceRef,
      tags: artifact.tags,
      entities: artifact.entities,
      scope: artifact.scope,
      query: artifact.query,
      summary: artifact.summary,
      content: artifact.content,
      importance: artifact.importance,
      confidence: artifact.confidence,
      source: artifact.source,
      createdAt: now,
      updatedAt: now,
    });
    recordArtifactWrite(context, "in-memory", "knowledge", artifact.memoryType ?? "semantic", artifact.query);
  }

  async insertProcedural(context: MemoryContext, artifact: ProceduralArtifactCandidate): Promise<void> {
    const now = new Date().toISOString();
    this.proceduralRecords.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      family: "procedural",
      memoryType: artifact.memoryType,
      layer: artifact.layer,
      status: artifact.status,
      salience: artifact.salience,
      retrievalWeight: artifact.retrievalWeight,
      repressionScore: artifact.repressionScore,
      linkedMemories: artifact.linkedMemories,
      screenFor: artifact.screenFor,
      triggerCues: artifact.triggerCues,
      consolidationState: artifact.consolidationState,
      version: artifact.version,
      sourceRef: artifact.sourceRef,
      tags: artifact.tags,
      entities: artifact.entities,
      sessionId: context.sessionId,
      projectId: context.projectId,
      query: artifact.query,
      assistantResponse: artifact.assistantResponse,
      toolChain: artifact.toolChain,
      createdAt: now,
      updatedAt: now,
    });
    recordArtifactWrite(context, "in-memory", "procedural", artifact.memoryType ?? "procedural", artifact.query, artifact.toolChain.length);
  }

  async searchKnowledge(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<KnowledgeArtifactRecord[]> {
    const results = searchKnowledgeRecords(this.knowledgeRecords, context, query, options.limit);
    recordArtifactSearch(context, "in-memory", "knowledge", query, options.limit, results.length);
    return results;
  }

  async searchProcedural(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<ProceduralArtifactRecord[]> {
    const results = searchProceduralRecords(this.proceduralRecords, context, query, options.limit);
    recordArtifactSearch(context, "in-memory", "procedural", query, options.limit, results.length);
    return results;
  }

  listKnowledge(): KnowledgeArtifactRecord[] {
    return [...this.knowledgeRecords];
  }

  listProcedural(): ProceduralArtifactRecord[] {
    return [...this.proceduralRecords];
  }
}

export class FileBackedArtifactStore implements ArtifactStore {
  async insertKnowledge(context: MemoryContext, artifact: KnowledgeArtifactCandidate): Promise<void> {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      family: "knowledge",
      memoryType: artifact.memoryType,
      layer: artifact.layer,
      status: artifact.status,
      salience: artifact.salience,
      valence: artifact.valence,
      arousal: artifact.arousal,
      retrievalWeight: artifact.retrievalWeight,
      repressionScore: artifact.repressionScore,
      linkedMemories: artifact.linkedMemories,
      screenFor: artifact.screenFor,
      triggerCues: artifact.triggerCues,
      consolidationState: artifact.consolidationState,
      version: artifact.version,
      sourceRef: artifact.sourceRef,
      tags: artifact.tags,
      entities: artifact.entities,
      scope: artifact.scope,
      query: artifact.query,
      summary: artifact.summary,
      content: artifact.content,
      importance: artifact.importance,
      confidence: artifact.confidence,
      source: artifact.source,
      createdAt: now,
      updatedAt: now,
    } satisfies KnowledgeArtifactRecord;
    await writeKnowledgeArtifactMarkdown(record);
    await appendIndexedKnowledgeArtifact(context.agentId, record);
    recordArtifactWrite(context, "markdown", "knowledge", artifact.memoryType ?? "semantic", artifact.query);
  }

  async insertProcedural(context: MemoryContext, artifact: ProceduralArtifactCandidate): Promise<void> {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      family: "procedural",
      memoryType: artifact.memoryType,
      layer: artifact.layer,
      status: artifact.status,
      salience: artifact.salience,
      retrievalWeight: artifact.retrievalWeight,
      repressionScore: artifact.repressionScore,
      linkedMemories: artifact.linkedMemories,
      screenFor: artifact.screenFor,
      triggerCues: artifact.triggerCues,
      consolidationState: artifact.consolidationState,
      version: artifact.version,
      sourceRef: artifact.sourceRef,
      tags: artifact.tags,
      entities: artifact.entities,
      sessionId: context.sessionId,
      projectId: context.projectId,
      query: artifact.query,
      assistantResponse: artifact.assistantResponse,
      toolChain: artifact.toolChain,
      createdAt: now,
      updatedAt: now,
    } satisfies ProceduralArtifactRecord;
    await writeProceduralArtifactMarkdown(record);
    await appendIndexedProceduralArtifact(context.agentId, record);
    recordArtifactWrite(context, "markdown", "procedural", artifact.memoryType ?? "procedural", artifact.query, artifact.toolChain.length);
  }

  async searchKnowledge(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<KnowledgeArtifactRecord[]> {
    const records = await loadIndexedKnowledgeArtifacts(context.agentId);
    const results = searchKnowledgeRecords(records, context, query, options.limit);
    recordArtifactSearch(context, "markdown", "knowledge", query, options.limit, results.length);
    return results;
  }

  async searchProcedural(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<ProceduralArtifactRecord[]> {
    const records = await loadIndexedProceduralArtifacts(context.agentId);
    const results = searchProceduralRecords(records, context, query, options.limit);
    recordArtifactSearch(context, "markdown", "procedural", query, options.limit, results.length);
    return results;
  }
}

function searchKnowledgeRecords(
  records: KnowledgeArtifactRecord[],
  context: MemoryContext,
  query: string,
  limit: number,
): KnowledgeArtifactRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .filter((record) => record.agentId === context.agentId)
    .map((record) => ({ record, score: scoreKnowledge(record, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record }) => record);
}

function searchProceduralRecords(
  records: ProceduralArtifactRecord[],
  context: MemoryContext,
  query: string,
  limit: number,
): ProceduralArtifactRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .filter((record) => record.agentId === context.agentId)
    .map((record) => ({ record, score: scoreProcedural(record, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record }) => record);
}

function scoreKnowledge(record: KnowledgeArtifactRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.summary} ${record.content}`.toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.importance;
}

function scoreProcedural(record: ProceduralArtifactRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.assistantResponse} ${record.toolChain.map((step) => step.toolName).join(" ")}`
    .toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.toolChain.length;
}

function recordArtifactWrite(
  context: MemoryContext,
  store: "in-memory" | "markdown",
  artifactFamily: "knowledge" | "procedural",
  memoryType: string,
  query: string,
  steps?: number,
): void {
  recordRuntimeObservation({
    name: "memory.artifact.write",
    message: "Stored a memory artifact.",
    data: {
      traceId: context.traceId,
      store,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      artifactFamily,
      memoryType,
      steps,
      query: truncate(query, 160),
    },
  });
}

function recordArtifactSearch(
  context: MemoryContext,
  store: "in-memory" | "markdown",
  artifactFamily: "knowledge" | "procedural",
  query: string,
  limit: number,
  count: number,
): void {
  recordRuntimeObservation({
    name: "memory.artifact.search",
    message: "Searched memory artifacts.",
    data: {
      traceId: context.traceId,
      store,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      artifactFamily,
      count,
      limit,
      query: truncate(query, 160),
    },
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
