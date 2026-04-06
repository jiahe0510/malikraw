import path from "node:path";

import { recordRuntimeObservation } from "../core/observability/observability.js";
import { readJsonFile, withFileLock, writeJsonFileAtomic } from "./file-store.js";
import { listKnowledgeArtifactMarkdownRecords, listProceduralArtifactMarkdownRecords } from "./markdown-store.js";
import { getMemoryStoreDirectory } from "./session-store.js";
import type { KnowledgeArtifactRecord, ProceduralArtifactRecord } from "./types.js";

type MemoryManifest<TRecord> = {
  version: 1;
  updatedAt: string;
  records: TRecord[];
};

export function getMemoryIndexesDirectory(): string {
  return path.join(getMemoryStoreDirectory(), "indexes");
}

export function getAgentManifestDirectory(agentId: string): string {
  return path.join(getMemoryIndexesDirectory(), "agents", sanitizePathSegment(agentId));
}

export function getKnowledgeArtifactManifestFilePath(agentId: string): string {
  return path.join(getAgentManifestDirectory(agentId), "knowledge-artifacts.json");
}

export function getProceduralArtifactManifestFilePath(agentId: string): string {
  return path.join(getAgentManifestDirectory(agentId), "procedural-artifacts.json");
}

export async function loadIndexedKnowledgeArtifacts(agentId: string): Promise<KnowledgeArtifactRecord[]> {
  const manifestPath = getKnowledgeArtifactManifestFilePath(agentId);
  const manifest = await readJsonFile<MemoryManifest<KnowledgeArtifactRecord> | null>(manifestPath, null);
  if (manifest?.records) {
    recordRuntimeObservation({
      name: "memory.index.load",
      message: "Loaded memory artifact manifest.",
      data: {
        agentId,
        manifest: "knowledge-artifacts",
        count: manifest.records.length,
      },
    });
    return manifest.records;
  }

  const records = await listKnowledgeArtifactMarkdownRecords(agentId);
  await writeManifest(manifestPath, records);
  recordRuntimeObservation({
    name: "memory.index.rebuild",
    message: "Rebuilt memory artifact manifest from markdown records.",
    data: {
      agentId,
      manifest: "knowledge-artifacts",
      count: records.length,
    },
  });
  return records;
}

export async function appendIndexedKnowledgeArtifact(agentId: string, record: KnowledgeArtifactRecord): Promise<void> {
  const manifestPath = getKnowledgeArtifactManifestFilePath(agentId);
  await withFileLock(manifestPath, async () => {
    const current = await readJsonFile<MemoryManifest<KnowledgeArtifactRecord>>(manifestPath, emptyManifest());
    await writeManifest(
      manifestPath,
      dedupeById([...current.records, record]),
    );
  });
  recordRuntimeObservation({
    name: "memory.index.update",
    message: "Updated memory artifact manifest.",
    data: {
      agentId,
      manifest: "knowledge-artifacts",
      recordId: record.id,
      memoryType: record.memoryType ?? "semantic",
    },
  });
}

export async function rebuildIndexedKnowledgeArtifacts(agentId: string): Promise<KnowledgeArtifactRecord[]> {
  const records = await listKnowledgeArtifactMarkdownRecords(agentId);
  await writeManifest(getKnowledgeArtifactManifestFilePath(agentId), records);
  return records;
}

export async function loadIndexedProceduralArtifacts(agentId: string): Promise<ProceduralArtifactRecord[]> {
  const manifestPath = getProceduralArtifactManifestFilePath(agentId);
  const manifest = await readJsonFile<MemoryManifest<ProceduralArtifactRecord> | null>(manifestPath, null);
  if (manifest?.records) {
    recordRuntimeObservation({
      name: "memory.index.load",
      message: "Loaded memory artifact manifest.",
      data: {
        agentId,
        manifest: "procedural-artifacts",
        count: manifest.records.length,
      },
    });
    return manifest.records;
  }

  const records = await listProceduralArtifactMarkdownRecords(agentId);
  await writeManifest(manifestPath, records);
  recordRuntimeObservation({
    name: "memory.index.rebuild",
    message: "Rebuilt memory artifact manifest from markdown records.",
    data: {
      agentId,
      manifest: "procedural-artifacts",
      count: records.length,
    },
  });
  return records;
}

export async function appendIndexedProceduralArtifact(agentId: string, record: ProceduralArtifactRecord): Promise<void> {
  const manifestPath = getProceduralArtifactManifestFilePath(agentId);
  await withFileLock(manifestPath, async () => {
    const current = await readJsonFile<MemoryManifest<ProceduralArtifactRecord>>(manifestPath, emptyManifest());
    await writeManifest(
      manifestPath,
      dedupeById([...current.records, record]),
    );
  });
  recordRuntimeObservation({
    name: "memory.index.update",
    message: "Updated memory artifact manifest.",
    data: {
      agentId,
      manifest: "procedural-artifacts",
      recordId: record.id,
      memoryType: record.memoryType ?? "procedural",
    },
  });
}

export async function rebuildIndexedProceduralArtifacts(agentId: string): Promise<ProceduralArtifactRecord[]> {
  const records = await listProceduralArtifactMarkdownRecords(agentId);
  await writeManifest(getProceduralArtifactManifestFilePath(agentId), records);
  return records;
}

async function writeManifest<TRecord extends { id: string }>(filePath: string, records: TRecord[]): Promise<void> {
  await writeJsonFileAtomic(filePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: dedupeById(records),
  } satisfies MemoryManifest<TRecord>);
}

function emptyManifest<TRecord>(): MemoryManifest<TRecord> {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    records: [],
  };
}

function dedupeById<TRecord extends { id: string }>(records: TRecord[]): TRecord[] {
  const byId = new Map<string, TRecord>();
  for (const record of records) {
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
