import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileRelevantMemoryBlock } from "../memory/memory-compiler.js";
import { extractSemanticHeuristically } from "../memory/extractors/semantic-extractor.js";
import { FileBackedMemoryItemStore, InMemoryMemoryItemStore } from "../memory/memory-item-store.js";
import {
  getGlobalMemoryItemsDirectory,
  getSessionStateFilePath,
} from "../memory/markdown-store.js";
import { MemoryRetriever } from "../memory/memory-retriever.js";
import { MemoryWriter } from "../memory/memory-writer.js";
import { FileBackedSessionStateStore, InMemorySessionStateStore } from "../memory/session-store.js";
import { InMemoryToolChainMemoryStore } from "../memory/tool-chain-store.js";
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
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();
  const writer = new MemoryWriter(sessionStore, memoryItemStore, toolChainStore);

  const result = await writer.write({
    context,
    trigger: "compaction",
    userMessage: "continue the refactor",
    assistantResponse: "done",
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
      summary: "Goal: finish the refactor. Decision: keep the transport builder separate from prompt collection.",
      messagesCompacted: 12,
      estimatedTokens: 2000,
    },
  });

  assert.equal(result.memoryItemsWritten, 1);
  assert.equal(result.toolChainsWritten, 1);

  const state = await sessionStore.read(context);
  assert.deepEqual(state?.state.handoff, [
    "Goal: finish the refactor. Decision: keep the transport builder separate from prompt collection.",
  ]);
  assert.deepEqual(state?.state.notes, []);

  const items = await memoryItemStore.searchRelevant(context, "transport builder", { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "history_compaction");
  assert.match(items[0]?.content ?? "", /Session handoff/);
});

test("memory writer stores explicit remember requests as session notes and global memory", async () => {
  const context = {
    sessionId: "s2",
    userId: "u2",
    agentId: "a2",
  };
  const sessionStore = new InMemorySessionStateStore();
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();
  const writer = new MemoryWriter(sessionStore, memoryItemStore, toolChainStore);

  const result = await writer.write({
    context,
    trigger: "explicit_memory",
    userMessage: "记住，我现在主要在 macOS 上开发，而且回答尽量简洁。",
    assistantResponse: "我记住了。",
    toolResults: [],
  });

  assert.equal(result.memoryItemsWritten, 1);
  assert.equal(result.toolChainsWritten, 0);

  const state = await sessionStore.read(context);
  assert.deepEqual(state?.state.handoff, []);
  assert.deepEqual(state?.state.notes, ["记住，我现在主要在 macOS 上开发，而且回答尽量简洁。"]);

  const items = await memoryItemStore.searchRelevant(context, "macOS 简洁", { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "user_explicit");
});

test("memory retriever compiles session handoff, notes, global memory, and tool chains", async () => {
  const context = {
    sessionId: "s3",
    userId: "u3",
    agentId: "a3",
    projectId: "p3",
  };
  const sessionStore = new InMemorySessionStateStore();
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();

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
  await memoryItemStore.insert(context, {
    query: "How should we implement memory?",
    summary: "Memory implementation plan",
    content: "Do one retrieval at query start, then keep search_memory as an on-demand tool.",
    scope: "global",
    importance: 0.9,
    confidence: 0.8,
    source: "task_summary",
  });
  await toolChainStore.insert(context, {
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

  const retriever = new MemoryRetriever(sessionStore, memoryItemStore, toolChainStore, {
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

  assert.match(result.compiledBlock, /\[Relevant Memory\]/);
  assert.match(result.compiledBlock, /Relevant user memory/);
  assert.match(result.compiledBlock, /Do one retrieval at query start/);
  assert.match(result.compiledBlock, /Session handoff/);
  assert.match(result.compiledBlock, /Goal: finish the memory runtime refactor/);
  assert.match(result.compiledBlock, /Remembered session notes/);
  assert.match(result.compiledBlock, /User prefers concise answers/);
  assert.match(result.compiledBlock, /Reusable tool chains/);
  assert.match(result.compiledBlock, /read_file -> edit_file/);
});

test("search_memory tool performs retrieval only when invoked", async () => {
  let retrieveCalls = 0;
  const tool = createMemorySearchTool({
    retrieve: async ({ query }) => {
      retrieveCalls += 1;
      return {
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
        memoryItems: [{
          id: "m1",
          userId: "u1",
          agentId: "a1",
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
        toolChains: [],
        compiledBlock: "[Relevant Memory]\nRelevant user memory:\n- Previous answer and notes.",
        observations: {
          memoryItemsWritten: 0,
          toolChainsWritten: 0,
          memoryItemsRetrieved: 1,
          toolChainsRetrieved: 0,
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
  assert.equal(result.compiledBlock, "[Relevant Memory]\nRelevant user memory:\n- Previous answer and notes.");
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
    memoryItems: [{
      id: "1",
      userId: "u1",
      agentId: "a1",
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
    toolChains: [],
    observations: {
      memoryItemsWritten: 0,
      toolChainsWritten: 0,
      memoryItemsRetrieved: 1,
      toolChainsRetrieved: 0,
      compiledChars: 0,
      estimatedTokens: 0,
    },
  }, {
    query: "preferred answer style",
    contextWindow: 2048,
    maxTokens: 1024,
  });

  assert.ok(block.length <= 600);
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

    assert.match(filePath, /\/memory\/agents\/main\/sessions\/shared-session\/session\.md$/);
    assert.match(markdown, /# Session Memory/);
    assert.match(markdown, /## Session Handoff/);
    assert.match(markdown, /Goal: finish the task/);
    assert.match(markdown, /## Remembered Notes/);
    assert.match(markdown, /terse replies/);
  } finally {
    restoreHome(previousHome);
  }
});

test("file-backed memory item store quarantines corrupt markdown and recovers with an empty dataset", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-memory-store-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;
  const context = {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
  };

  try {
    const directory = getGlobalMemoryItemsDirectory(context.agentId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "broken.md"), "# not-frontmatter", "utf8");

    const store = new FileBackedMemoryItemStore();
    const records = await store.searchRelevant(context, "anything", { limit: 10 });

    assert.deepEqual(records, []);
    const fileNames = await readdir(directory);
    assert.ok(fileNames.some((fileName) => fileName.includes(".corrupt-")));
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
