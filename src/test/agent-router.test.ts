import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage, AgentModel, ModelTurnResponse } from "../index.js";
import {
  InMemoryAgentCardRegistry,
  ModelBasedAgentRouter,
} from "../index.js";

test("agent router chooses exact taskKind match without model when unambiguous", async () => {
  const registry = new InMemoryAgentCardRegistry([
    {
      agentId: "sub-a",
      description: "repo analyzer",
      taskKinds: ["analyze_repo"],
      capabilities: ["repo_scan"],
    },
    {
      agentId: "sub-b",
      description: "summary writer",
      taskKinds: ["summarize_findings"],
      capabilities: ["summarization"],
    },
  ]);

  const router = new ModelBasedAgentRouter(registry, () => {
    throw new Error("model should not be used");
  });

  const decision = await router.route({
    taskKind: "analyze_repo",
    requiredCapabilities: ["repo_scan"],
  });

  assert.equal(decision.selectedAgentId, "sub-a");
  assert.match(decision.reason, /Rule-based routing selected/);
});

test("agent router uses model when multiple candidates tie", async () => {
  class FakeModel implements AgentModel {
    generate(input: { messages: AgentMessage[] }): ModelTurnResponse {
      assert.match(input.messages[1]?.content ?? "", /"taskKind": "analyze_repo"/);
      return {
        type: "final",
        outputText: JSON.stringify({
          selectedAgentId: "sub-b",
          reason: "sub-b has stronger code analysis specialization",
        }),
      };
    }
  }

  const registry = new InMemoryAgentCardRegistry([
    {
      agentId: "sub-a",
      description: "repo analyzer",
      taskKinds: ["analyze_repo"],
      capabilities: ["repo_scan"],
    },
    {
      agentId: "sub-b",
      description: "typescript analyzer",
      taskKinds: ["analyze_repo"],
      capabilities: ["repo_scan"],
    },
  ]);

  const router = new ModelBasedAgentRouter(registry, () => new FakeModel());
  const decision = await router.route({
    taskKind: "analyze_repo",
    requiredCapabilities: ["repo_scan"],
  });

  assert.equal(decision.selectedAgentId, "sub-b");
  assert.equal(decision.reason, "sub-b has stronger code analysis specialization");
});
