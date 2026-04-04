import test from "node:test";
import assert from "node:assert/strict";

import type { AgentModel, AgentModelRequest } from "../core/agent/types.js";
import { compactContextIfNeeded, reactivelyCompactMessages } from "../runtime/context-compactor.js";

class StubModel implements AgentModel {
  requests: AgentModelRequest[] = [];

  async generate(input: AgentModelRequest) {
    this.requests.push(input);
    return {
      type: "final" as const,
      outputText: [
        "Current State",
        "- Active user request: please continue",
        "- Latest retained state: deployment is blocked by failing tests",
      ].join("\n"),
    };
  }
}

test("compactContextIfNeeded can stop after micro compacting old tool payloads", async () => {
  const model = new StubModel();
  const history = [
    { role: "user" as const, content: "inspect the build logs" },
    { role: "assistant" as const, content: "I will inspect the logs." },
    { role: "tool" as const, toolName: "read_file", content: "x".repeat(6000) },
    { role: "user" as const, content: "what failed?" },
    { role: "assistant" as const, content: "The build failed." },
  ];

  const result = await compactContextIfNeeded({
    model,
    modelConfig: {
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 8192,
      maxTokens: 1024,
      compact: {
        thresholdTokens: 1200,
        targetTokens: 800,
      },
    },
    globalPolicy: "system policy",
    history,
    userRequest: "please continue",
  });

  assert.equal(result.triggered, true);
  assert.equal(result.strategy, "micro");
  assert.equal(model.requests.length, 0);
  assert.match(result.history[2]?.content ?? "", /^\[compacted_tool_result\]/);
});

test("compactContextIfNeeded produces structured session compact before summary fallback", async () => {
  const model = new StubModel();
  const history = [
    { role: "user" as const, content: "read /workspace/src/app.ts " + "u".repeat(1100) },
    { role: "assistant" as const, content: "Reviewing the file now. " + "a".repeat(1100) },
    { role: "tool" as const, toolName: "read_file", content: "export const app = " + "x".repeat(2600) },
    { role: "assistant" as const, content: "The module initializes the HTTP server. " + "b".repeat(1100) },
    { role: "user" as const, content: "check https://example.com/docs for the API change " + "c".repeat(900) },
    { role: "assistant" as const, content: "The API now requires a token header. " + "d".repeat(900) },
    { role: "user" as const, content: "recent question" },
    { role: "assistant" as const, content: "recent answer" },
  ];

  const result = await compactContextIfNeeded({
    model,
    modelConfig: {
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 8192,
      maxTokens: 1024,
      compact: {
        thresholdTokens: 600,
        targetTokens: 800,
      },
    },
    globalPolicy: "system policy",
    history,
    userRequest: "please continue",
  });

  assert.equal(result.triggered, true);
  assert.equal(result.strategy, "session");
  assert.equal(model.requests.length, 0);
  assert.match(result.history[0]?.content ?? "", /^\[compacted_history\]\nCurrent State/);
  assert.match(result.history[0]?.content ?? "", /Referenced Paths And URLs/);
  assert.equal(result.history.at(-2)?.content, "recent question");
  assert.equal(result.history.at(-1)?.content, "recent answer");
});

test("compactContextIfNeeded falls back to LLM summary when structured compact is still too large", async () => {
  const model = new StubModel();
  const history = [
    { role: "user" as const, content: "A".repeat(3000) },
    { role: "assistant" as const, content: "B".repeat(3000) },
    { role: "user" as const, content: "recent question" },
    { role: "assistant" as const, content: "recent answer" },
  ];

  const result = await compactContextIfNeeded({
    model,
    modelConfig: {
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 2048,
      maxTokens: 512,
      compact: {
        thresholdTokens: 700,
        targetTokens: 800,
      },
    },
    globalPolicy: "system policy",
    identitySystemContent: "identity ".repeat(300),
    personalitySystemContent: "personality ".repeat(300),
    agentSystemContent: "agent ".repeat(300),
    memorySystemContent: "memory ".repeat(300),
    history,
    userRequest: "please continue",
  });

  assert.equal(result.triggered, true);
  assert.equal(result.strategy, "summary");
  assert.equal(model.requests.length, 1);
  assert.match(result.history[0]?.content ?? "", /^\[compacted_history\]\nCurrent State/);
  assert.equal(result.history[1]?.content, "recent question");
  assert.equal(result.history[2]?.content, "recent answer");
});

test("compactContextIfNeeded leaves history intact below threshold", async () => {
  const model = new StubModel();
  const history = [
    { role: "user" as const, content: "short question" },
    { role: "assistant" as const, content: "short answer" },
  ];

  const result = await compactContextIfNeeded({
    model,
    modelConfig: {
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 8192,
      maxTokens: 1024,
      compact: {
        thresholdTokens: 4000,
        targetTokens: 1200,
      },
    },
    globalPolicy: "system policy",
    history,
    userRequest: "continue",
  });

  assert.equal(result.triggered, false);
  assert.deepEqual(result.history, history);
  assert.equal(model.requests.length, 0);
});

test("reactivelyCompactMessages preserves instruction prefix and compacts the conversation body", () => {
  const result = reactivelyCompactMessages({
    modelConfig: {
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 4096,
      maxTokens: 1024,
      compact: {
        thresholdTokens: 1200,
        targetTokens: 700,
      },
    },
    messages: [
      { role: "system", content: "global policy" },
      { role: "developer", content: "Runtime Context" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "tool", toolName: "read_file", content: "z".repeat(5000) },
      { role: "user", content: "latest question" },
    ],
  });

  assert.equal(result.triggered, true);
  assert.equal(result.strategy, "reactive");
  assert.equal(result.messages[0]?.role, "system");
  assert.equal(result.messages[1]?.role, "developer");
  assert.match(result.messages[2]?.content ?? "", /^\[compacted_history\]/);
  assert.equal(result.messages.at(-1)?.content, "latest question");
});
