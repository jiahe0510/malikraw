import test from "node:test";
import assert from "node:assert/strict";

import { compileRelevantMemoryBlock } from "../memory/memory-compiler.js";
import { HeuristicEpisodeExtractor } from "../memory/extractors/episode-extractor.js";
import { extractSemanticHeuristically } from "../memory/extractors/semantic-extractor.js";
import { InMemoryEpisodicMemoryStore } from "../memory/episodic-store.js";
import { MemoryRetriever } from "../memory/memory-retriever.js";
import { MemoryWriter } from "../memory/memory-writer.js";
import { InMemorySemanticMemoryStore } from "../memory/semantic-store.js";
import { InMemorySessionStateStore } from "../memory/session-store.js";

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

test("memory writer persists session state and deduplicated semantic memory", async () => {
  const sessionStore = new InMemorySessionStateStore();
  const semanticStore = new InMemorySemanticMemoryStore();
  const episodicStore = new InMemoryEpisodicMemoryStore();
  const writer = new MemoryWriter(
    sessionStore,
    semanticStore,
    episodicStore,
    {
      extract: async () => [{
        key: "project_stack",
        value: "TypeScript",
        scope: "project",
        confidence: 0.9,
        source: "explicit",
        summary: "Current project stack is TypeScript.",
      }],
    },
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
  assert.equal(result.semanticWritten, 1);
  assert.equal(result.episodeWritten, true);

  const state = await sessionStore.read(input.context);
  assert.equal(state?.state.recentMessages.length, 2);

  await writer.write(input);
  const semantic = await semanticStore.listRelevant(input.context, ["project"], 10);
  assert.equal(semantic.length, 1);
});

test("memory writer stores compaction summaries as episodic memory", async () => {
  const context = {
    sessionId: "s2",
    userId: "u2",
    agentId: "a2",
  };
  const sessionStore = new InMemorySessionStateStore();
  const semanticStore = new InMemorySemanticMemoryStore();
  const episodicStore = new InMemoryEpisodicMemoryStore();
  const writer = new MemoryWriter(
    sessionStore,
    semanticStore,
    episodicStore,
    { extract: async () => [] },
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

  const episodes = await episodicStore.searchRelevant(context, "compress history", { limit: 10 });
  assert.ok(episodes.some((episode) => episode.source === "history_compaction"));
  assert.ok(episodes.some((episode) => /compress only history/i.test(episode.summary)));
});

test("memory retriever compiles session, semantic, and episodic memory into one block", async () => {
  const context = {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
    projectId: "p1",
  };
  const sessionStore = new InMemorySessionStateStore();
  const semanticStore = new InMemorySemanticMemoryStore();
  const episodicStore = new InMemoryEpisodicMemoryStore();
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
  await semanticStore.upsertMany(context, [{
    key: "answer_style",
    value: "implementation-focused",
    scope: "global",
    confidence: 0.95,
    source: "explicit",
    summary: "User prefers implementation-focused answers.",
  }]);
  await episodicStore.insert(context, {
    summary: "Recently designed a three-phase memory implementation plan.",
    entities: ["Redis", "Postgres"],
    importance: 0.9,
    confidence: 0.8,
  });

  const retriever = new MemoryRetriever(sessionStore, semanticStore, episodicStore, memoryConfig);
  const result = await retriever.retrieve({
    context,
    query: "How should we implement memory?",
  });

  assert.match(result.compiledBlock, /\[Relevant Memory\]/);
  assert.match(result.compiledBlock, /implementation-focused/);
  assert.match(result.compiledBlock, /three-phase memory implementation plan/);
  assert.match(result.compiledBlock, /Goal: Implement memory/);
  assert.ok(result.observations.compiledChars > 0);
});

test("compileRelevantMemoryBlock enforces a prompt budget", () => {
  const block = compileRelevantMemoryBlock({
    sessionState: undefined,
    semantic: [{
      id: "1",
      userId: "u1",
      agentId: "a1",
      scope: "global",
      key: "pref",
      summary: "x".repeat(400),
      value: "x",
      confidence: 0.9,
      importance: 1,
      source: "user_explicit",
      content: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    episodes: [],
    observations: {
      semanticWritten: 0,
      episodesWritten: 0,
      semanticRetrieved: 1,
      episodesRetrieved: 0,
      compiledChars: 0,
      estimatedTokens: 0,
    },
  }, 120);

  assert.ok(block.length <= 120);
});
