import test from "node:test";
import assert from "node:assert/strict";

import type { AgentModel, AgentModelRequest } from "../core/agent/types.js";
import { compactContextIfNeeded } from "../runtime/context-compactor.js";

class StubModel implements AgentModel {
  requests: AgentModelRequest[] = [];

  async generate(input: AgentModelRequest) {
    this.requests.push(input);
    return {
      type: "final" as const,
      outputText: [
        "Goal: implement compact tokens",
        "Constraints: only compact history",
        "Decisions: persist summary to memory",
      ].join("\n"),
    };
  }
}

test("compactContextIfNeeded compacts only history when threshold is exceeded", async () => {
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
      contextWindow: 8192,
      maxTokens: 1024,
      compact: {
        thresholdTokens: 1000,
        targetTokens: 800,
      },
    },
    globalPolicy: "system policy",
    identitySystemContent: "identity",
    personalitySystemContent: "personality",
    agentSystemContent: "agent",
    memorySystemContent: "memory",
    history,
    userRequest: "please continue",
  });

  assert.equal(result.triggered, true);
  assert.equal(result.messagesCompacted, 2);
  assert.equal(model.requests.length, 1);
  assert.match(result.history[0]?.content ?? "", /^\[compacted_history\]\nGoal:/);
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
