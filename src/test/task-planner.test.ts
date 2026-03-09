import test from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage, AgentModel, ModelTurnResponse } from "../index.js";
import { ModelBasedTaskPlanner } from "../index.js";

test("task planner converts natural language into a structured task spec", async () => {
  class FakeModel implements AgentModel {
    generate(input: { messages: AgentMessage[] }): ModelTurnResponse {
      assert.match(input.messages[1]?.content ?? "", /Analyze the repo and summarize the findings/);
      return {
        type: "final",
        outputText: JSON.stringify({
          input: {
            query: "Analyze the repo and summarize the findings",
          },
          initialStep: {
            stepName: "analyze",
            taskKind: "analyze_repo",
            workflowNodeId: "analyze",
            input: {
              userRequest: "Analyze the current repository and return strict JSON with needB and payloadForB.",
            },
          },
          workflow: {
            transitions: [
              {
                on: "analyze",
                when: {
                  path: "needB",
                  equals: true,
                },
                createStep: {
                  stepName: "summarize",
                  taskKind: "summarize_findings",
                  requiredCapabilities: ["report_writing"],
                  workflowNodeId: "summarize",
                  inputFromOutputPath: "payloadForB",
                },
              },
            ],
          },
        }),
      };
    }
  }

  const planner = new ModelBasedTaskPlanner(new FakeModel(), {
    workspaceRoot: "/workspace/repo",
    agentCards: [
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
        capabilities: ["report_writing"],
      },
    ],
  });

  const planned = await planner.plan("Analyze the repo and summarize the findings");

  assert.equal(planned.initialStep.taskKind, "analyze_repo");
  assert.equal(planned.workflow?.transitions?.[0]?.createStep.taskKind, "summarize_findings");
});
