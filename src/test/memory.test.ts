import test from "node:test";
import assert from "node:assert/strict";

import { compileRelevantMemoryBlock } from "../memory/memory-compiler.js";
import { HeuristicEpisodeExtractor } from "../memory/extractors/episode-extractor.js";
import { extractSemanticHeuristically } from "../memory/extractors/semantic-extractor.js";
import { InMemoryMemoryItemStore } from "../memory/memory-item-store.js";
import { MemoryRetriever } from "../memory/memory-retriever.js";
import { MemoryWriter } from "../memory/memory-writer.js";
import { InMemorySessionStateStore } from "../memory/session-store.js";
import { InMemoryToolChainMemoryStore } from "../memory/tool-chain-store.js";
import { createMemorySearchTool } from "../tools/search-memory.js";

const memoryConfig = {
  enabled: true,
  embeddingDimensions: 1536,
  sessionRecentMessages: 4,
  semanticTopK: 6,
  episodicTopK: 4,
  maxPromptChars: 800,
  importanceThreshold: 0.65,
} as const;

test("heuristic semantic extractor keeps stable preferences and constraints only", () => {
  const facts = extractSemanticHeuristically({
    context: {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
    },
    userMessage: "我偏好 implementation-focused answers\n项目 tech stack: TypeScript\n必须保留 breaking change",
    assistantResponse: "ok",
    toolResults: [],
    sessionMessages: [],
  });

  assert.deepEqual(facts.map((item) => item.key), [
    "user_preference",
    "project_stack",
    "breaking_change",
  ]);
});

test("memory writer persists session state and query-indexed memory items", async () => {
  const sessionStore = new InMemorySessionStateStore();
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();
  const writer = new MemoryWriter(
    sessionStore,
    memoryItemStore,
    toolChainStore,
    new HeuristicEpisodeExtractor(),
    memoryConfig,
  );

  const input = {
    context: {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
    },
    userMessage: "Use TypeScript",
    assistantResponse: "Completed the refactor.",
    toolResults: [{
      toolName: "edit_file",
      traceId: "t1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      ok: true as const,
      data: { path: "src/app.ts" },
    }],
    sessionMessages: [
      { role: "user" as const, content: "Use TypeScript" },
      { role: "assistant" as const, content: "Completed the refactor." },
    ],
  };

  const result = await writer.write(input);
  assert.equal(result.memoryItemsWritten, 1);

  const state = await sessionStore.read(input.context);
  assert.equal(state?.state.recentMessages.length, 2);

  await writer.write(input);
  const items = await memoryItemStore.searchRelevant(input.context, "Use TypeScript", { limit: 10 });
  assert.equal(items.length, 2);
  assert.match(items[0]?.content ?? "", /Use TypeScript/);
});

test("memory writer stores compaction summaries as query-indexed memory items", async () => {
  const context = {
    sessionId: "s2",
    userId: "u2",
    agentId: "a2",
  };
  const sessionStore = new InMemorySessionStateStore();
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();
  const writer = new MemoryWriter(
    sessionStore,
    memoryItemStore,
    toolChainStore,
    new HeuristicEpisodeExtractor(),
    memoryConfig,
  );

  await writer.write({
    context,
    userMessage: "continue",
    assistantResponse: "done",
    toolResults: [],
    sessionMessages: [
      { role: "user", content: "continue" },
      { role: "assistant", content: "done" },
    ],
    compaction: {
      summary: "Goal: add provider compact config. Decisions: compress only history.",
      messagesCompacted: 12,
      estimatedTokens: 3000,
    },
  });

  const items = memoryItemStore.list();
  assert.ok(items.some((item) => item.source === "history_compaction"));
  assert.ok(items.some((item) => /compress only history/i.test(item.content)));
});

test("memory retriever compiles query memory and tool chains into one block", async () => {
  const context = {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
    projectId: "p1",
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
      recentMessages: [
        { role: "user", content: "Need a plan" },
        { role: "assistant", content: "I will implement it." },
      ],
      taskState: {
        goal: "Implement memory",
        currentPlan: ["Add stores", "Integrate runtime"],
        completedSteps: ["Add schema"],
        openQuestions: ["How to configure Redis?"],
        status: "active",
        updatedAt: new Date().toISOString(),
      },
    },
  });
  await memoryItemStore.insert(context, {
    query: "How should we implement memory?",
    summary: "Memory implementation plan",
    content: "Use Redis and Postgres and stage the implementation in three phases.",
    scope: "project",
    importance: 0.9,
    confidence: 0.8,
    source: "task_summary",
  });

  await toolChainStore.insert(context, {
    query: "How should we implement memory?",
    assistantResponse: "Use Redis and Postgres, then run migrations.",
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

  const retriever = new MemoryRetriever(sessionStore, memoryItemStore, toolChainStore, memoryConfig);
  const result = await retriever.retrieve({
    context,
    query: "How should we implement memory?",
  });

  assert.match(result.compiledBlock, /\[Relevant Memory\]/);
  assert.match(result.compiledBlock, /Relevant user memory/);
  assert.match(result.compiledBlock, /Use Redis and Postgres and stage the implementation/);
  assert.match(result.compiledBlock, /Reusable tool chains/);
  assert.match(result.compiledBlock, /read_file -> edit_file/);
  assert.match(result.compiledBlock, /Goal: Implement memory/);
  assert.ok(result.observations.compiledChars > 0);
  assert.equal(result.observations.memoryItemsRetrieved, 1);
  assert.equal(result.observations.toolChainsRetrieved, 1);
});

test("search_memory tool performs retrieval only when invoked", async () => {
  let retrieveCalls = 0;
  const tool = createMemorySearchTool({
    retrieve: async ({ query }) => {
      retrieveCalls += 1;
      return {
        sessionState: undefined,
        memoryItems: [{
          id: "m1",
          userId: "u1",
          agentId: "a1",
          scope: "project",
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
  assert.equal(result.memoryItems.length, 1);
});

test("compileRelevantMemoryBlock enforces a prompt budget", () => {
  const block = compileRelevantMemoryBlock({
    sessionState: undefined,
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
  }, 120);

  assert.ok(block.length <= 120);
});

test("memory writer stores one tool chain per user query", async () => {
  const context = {
    sessionId: "s3",
    userId: "u3",
    agentId: "a3",
  };
  const sessionStore = new InMemorySessionStateStore();
  const memoryItemStore = new InMemoryMemoryItemStore();
  const toolChainStore = new InMemoryToolChainMemoryStore();
  const writer = new MemoryWriter(
    sessionStore,
    memoryItemStore,
    toolChainStore,
    new HeuristicEpisodeExtractor(),
    memoryConfig,
  );

  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const result = await writer.write({
    context,
    userMessage: "查一下最近的国际新闻",
    assistantResponse: "我已经检索并整理了结果。",
    toolResults: [
      {
        toolName: "web_search",
        traceId: "t1",
        startedAt,
        finishedAt,
        durationMs: 12,
        ok: true,
        data: { query: "国际新闻" },
      },
      {
        toolName: "open_page",
        traceId: "t2",
        startedAt,
        finishedAt,
        durationMs: 8,
        ok: true,
        data: { url: "https://example.com" },
      },
    ],
    sessionMessages: [
      { role: "user", content: "查一下最近的国际新闻" },
      { role: "assistant", content: "我已经检索并整理了结果。" },
    ],
  });

  assert.equal(result.toolChainsWritten, 1);
  const records = toolChainStore.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.query, "查一下最近的国际新闻");
  assert.equal(records[0]?.toolChain.length, 2);
  assert.deepEqual(records[0]?.toolChain.map((step) => step.toolName), ["web_search", "open_page"]);
});
