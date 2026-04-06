import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileBackedArtifactStore, InMemoryArtifactStore } from "../memory/artifact-store.js";
import { compileRelevantMemoryBlock } from "../memory/memory-compiler.js";
import { extractSemanticHeuristically } from "../memory/extractors/semantic-extractor.js";
import {
  getKnowledgeArtifactManifestFilePath,
  getProceduralArtifactManifestFilePath,
} from "../memory/manifest-store.js";
import {
  getLtmMemoryTypeDirectory,
  getSessionStateFilePath,
} from "../memory/markdown-store.js";
import { MemoryRetriever } from "../memory/memory-retriever.js";
import { MemoryWriter } from "../memory/memory-writer.js";
import { FileBackedSessionStateStore, InMemorySessionStateStore } from "../memory/session-store.js";
import { createMemorySearchTool } from "../tools/search-memory.js";

test("heuristic semantic extractor keeps stable preferences and constraints only", () => {
  const facts = extractSemanticHeuristically({
    context: {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
    },
    trigger: "explicit_memory",
    userMessage: "我偏好 implementation-focused answers\n项目 tech stack: TypeScript\n必须保留 breaking change",
    assistantResponse: "ok",
    toolResults: [],
  });

  assert.deepEqual(facts.map((item) => item.key), [
    "user_preference",
    "project_stack",
    "breaking_change",
  ]);
});

test("memory writer only writes durable compaction handoff instead of per-turn transcript", async () => {
  const context = {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
  };
  const sessionStore = new InMemorySessionStateStore();
  const artifactStore = new InMemoryArtifactStore();
  const writer = new MemoryWriter(sessionStore, artifactStore);

  const result = await writer.write({
    context,
    trigger: "compaction",
    userMessage: "continue the refactor, recurring avoidance around audience judgment",
    assistantResponse: "done, but there is still repeated avoidance before public review",
    toolResults: [{
      toolName: "edit_file",
      traceId: "t1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 2,
      ok: true,
      data: { path: "src/app.ts" },
    }],
    compaction: {
      summary: "Goal: finish the refactor. Decision: keep the transport builder separate from prompt collection. Recurring avoidance appears before audience judgment, with anticipated failure and shame cues.",
      messagesCompacted: 12,
      estimatedTokens: 2000,
    },
  });

  assert.equal(result.knowledgeArtifactsWritten, 3);
  assert.equal(result.proceduralArtifactsWritten, 1);

  const state = await sessionStore.read(context);
  assert.deepEqual(state?.state.handoff, [
    "Goal: finish the refactor. Decision: keep the transport builder separate from prompt collection. Recurring avoidance appears before audience judgment, with anticipated failure and shame cues.",
  ]);
  assert.deepEqual(state?.state.notes, []);

  const items = artifactStore.listKnowledge();
  assert.ok(items.some((item) => item.memoryType === "episodic"));
  assert.ok(items.some((item) => item.memoryType === "symptom"));
  assert.ok(items.some((item) => item.memoryType === "repressed"));
  const episodic = items.find((item) => item.memoryType === "episodic");
  assert.equal(episodic?.source, "history_compaction");
  assert.equal(episodic?.layer, "ltm");
  assert.match(episodic?.content ?? "", /Session handoff/);

  const proceduralArtifacts = artifactStore.listProcedural();
  assert.equal(proceduralArtifacts.length, 1);
  assert.equal(proceduralArtifacts[0]?.memoryType, "procedural");
  assert.equal(proceduralArtifacts[0]?.layer, "ltm");
});

test("memory writer stores explicit remember requests as session notes and global memory", async () => {
  const context = {
    sessionId: "s2",
    userId: "u2",
    agentId: "a2",
  };
  const sessionStore = new InMemorySessionStateStore();
  const artifactStore = new InMemoryArtifactStore();
  const writer = new MemoryWriter(sessionStore, artifactStore);

  const result = await writer.write({
    context,
    trigger: "explicit_memory",
    userMessage: "记住，我现在主要在 macOS 上开发，而且回答尽量简洁。我对公开演示一直很焦虑。",
    assistantResponse: "我记住了，也会留意这个焦虑触发点。",
    toolResults: [],
  });

  assert.equal(result.knowledgeArtifactsWritten, 2);
  assert.equal(result.proceduralArtifactsWritten, 0);

  const state = await sessionStore.read(context);
  assert.deepEqual(state?.state.handoff, []);
  assert.deepEqual(state?.state.notes, ["记住，我现在主要在 macOS 上开发，而且回答尽量简洁。我对公开演示一直很焦虑。"]);

  const items = artifactStore.listKnowledge();
  assert.ok(items.some((item) => item.memoryType === "semantic"));
  assert.ok(items.some((item) => item.memoryType === "affective"));
  const semantic = items.find((item) => item.memoryType === "semantic");
  assert.equal(semantic?.source, "user_explicit");
  assert.equal(semantic?.layer, "ltm");
});

test("memory compiler surfaces symptom and guarded memory in a separate section", () => {
  const block = compileRelevantMemoryBlock({
    sessionState: undefined,
    knowledgeArtifacts: [{
      id: "m-sym",
      userId: "u1",
      agentId: "a1",
      family: "knowledge" as const,
      scope: "global",
      query: "public speaking",
      summary: "Recurring avoidance before audience-facing work",
      content: "Pattern detected across several similar requests.",
      importance: 0.8,
      confidence: 0.7,
      source: "history_compaction",
      memoryType: "symptom",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      id: "m-rep",
      userId: "u1",
      agentId: "a1",
      family: "knowledge" as const,
      scope: "global",
      query: "public speaking",
      summary: "Guarded hypothesis around anticipated humiliation",
      content: "Keep this indirect unless more evidence appears.",
      importance: 0.7,
      confidence: 0.4,
      source: "history_compaction",
      memoryType: "repressed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    proceduralArtifacts: [],
    observations: {
      knowledgeArtifactsWritten: 0,
      proceduralArtifactsWritten: 0,
      knowledgeArtifactsRetrieved: 2,
      proceduralArtifactsRetrieved: 0,
      compiledChars: 0,
      estimatedTokens: 0,
    },
  }, {
    query: "help me with public speaking",
    mode: "analytic",
    contextWindow: 8192,
    maxTokens: 1024,
  });

  assert.match(block, /Patterns:/);
  assert.match(block, /Pattern \(symptom\):/);
  assert.match(block, /Hypotheses:/);
  assert.match(block, /Hypothesis \(guarded\):/);
});

test("memory retriever compiles session handoff, notes, global memory, and tool chains", async () => {
  const context = {
    sessionId: "s3",
    userId: "u3",
    agentId: "a3",
    projectId: "p3",
  };
  const sessionStore = new InMemorySessionStateStore();
  const artifactStore = new InMemoryArtifactStore();

  await sessionStore.write({
    sessionId: context.sessionId,
    userId: context.userId,
    agentId: context.agentId,
    projectId: context.projectId,
    updatedAt: new Date().toISOString(),
    state: {
      handoff: ["Goal: finish the memory runtime refactor."],
      notes: ["User prefers concise answers."],
    },
  });
  await artifactStore.insertKnowledge(context, {
    query: "How should we implement memory?",
    summary: "Memory implementation plan",
    content: "Do one retrieval at query start, then keep search_memory as an on-demand tool.",
    scope: "global",
    importance: 0.9,
    confidence: 0.8,
    source: "task_summary",
  });
  await artifactStore.insertProcedural(context, {
    query: "How should we implement memory?",
    assistantResponse: "Use read_file, edit_file, then test.",
    toolChain: [
      {
        toolName: "read_file",
        ok: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 2,
      },
      {
        toolName: "edit_file",
        ok: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 3,
      },
    ],
  });

  const retriever = new MemoryRetriever(sessionStore, artifactStore, {
    baseURL: "https://example.invalid/v1",
    apiKey: "dummy",
    model: "test-model",
    contextWindow: 8192,
    maxTokens: 1024,
    compact: {
      thresholdTokens: 4096,
      targetTokens: 2048,
    },
  });
  const result = await retriever.retrieve({
    context,
    query: "How should we implement memory?",
  });

  assert.equal(result.mode, "normal");
  assert.match(result.compiledBlock, /\[Relevant Memory\]/);
  assert.match(result.compiledBlock, /Facts:/);
  assert.match(result.compiledBlock, /Do one retrieval at query start/);
  assert.match(result.compiledBlock, /STM session snapshot/);
  assert.match(result.compiledBlock, /Goal: finish the memory runtime refactor/);
  assert.match(result.compiledBlock, /Remembered session notes/);
  assert.match(result.compiledBlock, /User prefers concise answers/);
  assert.match(result.compiledBlock, /Procedural memory/);
  assert.match(result.compiledBlock, /read_file -> edit_file/);
});

test("search_memory tool performs retrieval only when invoked", async () => {
  let retrieveCalls = 0;
  const tool = createMemorySearchTool({
    retrieve: async ({ query, mode }) => {
      retrieveCalls += 1;
      return {
        mode: mode ?? "normal",
        sessionState: {
          sessionId: "s1",
          userId: "u1",
          agentId: "a1",
          updatedAt: new Date().toISOString(),
          state: {
            handoff: ["Carry the current refactor forward."],
            notes: ["Prefer concise answers."],
          },
        },
        knowledgeArtifacts: [{
          id: "m1",
          userId: "u1",
          agentId: "a1",
          family: "knowledge" as const,
          scope: "global",
          query,
          summary: "Stored memory",
          content: "Previous answer and notes.",
          importance: 0.8,
          confidence: 0.9,
          source: "task_summary",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        proceduralArtifacts: [],
        compiledBlock: "[Relevant Memory]\nFacts:\n- Fact (semantic): Stored memory | Previous answer and notes.",
        observations: {
          knowledgeArtifactsWritten: 0,
          proceduralArtifactsWritten: 0,
          knowledgeArtifactsRetrieved: 1,
          proceduralArtifactsRetrieved: 0,
          compiledChars: 72,
          estimatedTokens: 18,
        },
      };
    },
    write: async () => {
      throw new Error("not used");
    },
  }, {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
    projectId: "p1",
  });

  const result = await tool.execute({ query: "similar issue" }, {
    traceId: "trace-1",
    now: () => new Date(),
  });

  assert.equal(retrieveCalls, 1);
  assert.equal(result.mode, "normal");
  assert.equal(result.compiledBlock, "[Relevant Memory]\nFacts:\n- Fact (semantic): Stored memory | Previous answer and notes.");
  assert.equal(result.knowledgeArtifacts[0]?.tier, "fact");
  assert.deepEqual(result.sessionState, {
    handoff: ["Carry the current refactor forward."],
    notes: ["Prefer concise answers."],
  });
});

test("compileRelevantMemoryBlock enforces a prompt budget", () => {
  const block = compileRelevantMemoryBlock({
    sessionState: {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
      updatedAt: new Date().toISOString(),
      state: {
        handoff: ["x".repeat(400)],
        notes: ["y".repeat(400)],
      },
    },
    knowledgeArtifacts: [{
      id: "1",
      userId: "u1",
      agentId: "a1",
      family: "knowledge" as const,
      scope: "global",
      query: "preferred answer style",
      summary: "x".repeat(400),
      content: "x".repeat(400),
      confidence: 0.9,
      importance: 1,
      source: "user_explicit",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    proceduralArtifacts: [],
    observations: {
      knowledgeArtifactsWritten: 0,
      proceduralArtifactsWritten: 0,
      knowledgeArtifactsRetrieved: 1,
      proceduralArtifactsRetrieved: 0,
      compiledChars: 0,
      estimatedTokens: 0,
    },
  }, {
    query: "preferred answer style",
    mode: "normal",
    contextWindow: 2048,
    maxTokens: 1024,
  });

  assert.ok(block.length <= 600);
});

test("analytic memory mode surfaces guarded memory while normal mode keeps it out of prompt", () => {
  const baseInput = {
    sessionState: undefined,
    knowledgeArtifacts: [{
      id: "m-rep",
      userId: "u1",
      agentId: "a1",
      family: "knowledge" as const,
      scope: "global" as const,
      query: "public speaking",
      summary: "Guarded hypothesis around anticipated humiliation",
      content: "Keep this indirect unless more evidence appears.",
      importance: 0.7,
      confidence: 0.4,
      source: "history_compaction" as const,
      memoryType: "repressed" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    proceduralArtifacts: [],
    observations: {
      knowledgeArtifactsWritten: 0,
      proceduralArtifactsWritten: 0,
      knowledgeArtifactsRetrieved: 1,
      proceduralArtifactsRetrieved: 0,
      compiledChars: 0,
      estimatedTokens: 0,
    },
  };

  const normal = compileRelevantMemoryBlock(baseInput, {
    query: "help me with public speaking",
    mode: "normal",
    contextWindow: 8192,
    maxTokens: 1024,
  });
  const analytic = compileRelevantMemoryBlock(baseInput, {
    query: "analyze why this keeps happening in public speaking",
    mode: "analytic",
    contextWindow: 8192,
    maxTokens: 1024,
  });

  assert.equal(normal, "");
  assert.match(analytic, /Hypotheses:/);
  assert.match(analytic, /Hypothesis \(guarded\):/);
});

test("file-backed session memory is stored as markdown under .malikraw/memory", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-memory-store-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const context = {
      sessionId: "shared-session",
      userId: "u1",
      agentId: "main",
      projectId: "p1",
    };
    const store = new FileBackedSessionStateStore();
    await store.write({
      sessionId: context.sessionId,
      userId: context.userId,
      agentId: context.agentId,
      projectId: context.projectId,
      updatedAt: new Date().toISOString(),
      state: {
        handoff: ["Goal: finish the task."],
        notes: ["Remember the user prefers terse replies."],
      },
    });

    const filePath = getSessionStateFilePath(context);
    const markdown = await readFile(filePath, "utf8");

    assert.match(filePath, /\/memory\/agents\/main\/stm\/snapshots\/sessions\/shared-session\/session\.md$/);
    assert.match(markdown, /# STM Session Snapshot/);
    assert.match(markdown, /## Session Handoff/);
    assert.match(markdown, /Goal: finish the task/);
    assert.match(markdown, /## Remembered Notes/);
    assert.match(markdown, /terse replies/);
  } finally {
    restoreHome(previousHome);
  }
});

test("file-backed artifact store quarantines corrupt markdown and recovers with an empty dataset", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-memory-store-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;
  const context = {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
  };

  try {
    const directory = getLtmMemoryTypeDirectory(context.agentId, "semantic");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "broken.md"), "# not-frontmatter", "utf8");

    const store = new FileBackedArtifactStore();
    const records = await store.searchKnowledge(context, "anything", { limit: 10 });

    assert.deepEqual(records, []);
    const fileNames = await readdir(directory);
    assert.ok(fileNames.some((fileName) => fileName.includes(".corrupt-")));
  } finally {
    restoreHome(previousHome);
  }
});

test("file-backed memory stores update manifest indexes under .malikraw/memory/indexes", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-memory-index-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;
  const context = {
    sessionId: "s-manifest",
    userId: "u-manifest",
    agentId: "a-manifest",
    projectId: "p-manifest",
  };

  try {
    const artifactStore = new FileBackedArtifactStore();

    await artifactStore.insertKnowledge(context, {
      query: "how do we ship this",
      summary: "Shipping plan",
      content: "Cut scope and ship the stable API first.",
      scope: "global",
      importance: 0.9,
      confidence: 0.8,
      source: "task_summary",
      memoryType: "semantic",
      layer: "ltm",
      status: "consolidated",
    });

    await artifactStore.insertProcedural(context, {
      query: "how do we ship this",
      assistantResponse: "Use read_file then edit_file.",
      toolChain: [{
        toolName: "read_file",
        ok: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 2,
      }],
      memoryType: "procedural",
      layer: "ltm",
      status: "consolidated",
    });

    const knowledgeManifest = JSON.parse(await readFile(getKnowledgeArtifactManifestFilePath(context.agentId), "utf8"));
    const proceduralManifest = JSON.parse(await readFile(getProceduralArtifactManifestFilePath(context.agentId), "utf8"));

    assert.equal(knowledgeManifest.version, 1);
    assert.equal(proceduralManifest.version, 1);
    assert.equal(knowledgeManifest.records.length, 1);
    assert.equal(proceduralManifest.records.length, 1);
    assert.equal(knowledgeManifest.records[0]?.summary, "Shipping plan");
    assert.equal(proceduralManifest.records[0]?.query, "how do we ship this");
  } finally {
    restoreHome(previousHome);
  }
});

function restoreHome(previousHome: string | undefined): void {
  if (previousHome === undefined) {
    delete process.env.MALIKRAW_HOME;
    return;
  }

  process.env.MALIKRAW_HOME = previousHome;
}
