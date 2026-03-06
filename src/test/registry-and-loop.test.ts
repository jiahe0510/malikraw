import test from "node:test";
import assert from "node:assert/strict";

import {
  ManualSkillRouter,
  SkillRegistry,
  ToolRegistry,
  buildPrompt,
  defineTool,
  getVisibleToolNames,
  parseSkillMarkdown,
  runAgentLoop,
  s,
  type AgentMessage,
  type AgentModel,
  type ModelTurnResponse,
} from "../index.js";

test("tool registry returns validation errors in envelope", async () => {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "sum_numbers",
    description: "Add integers.",
    inputSchema: s.object(
      { values: s.array(s.number({ integer: true }), { minItems: 1 }) },
      { required: ["values"] },
    ),
    execute: ({ values }) => ({ total: values.reduce((a: number, b: number) => a + b, 0) }),
  }));

  const result = await registry.execute("sum_numbers", { values: [1, "x"] });

  assert.equal(result.ok, false);
  if (!result.ok && result.error.type === "validation_error") {
    assert.equal(result.error.type, "validation_error");
    assert.equal(result.error.issues[0]?.path, "$.values[1]");
  }
});

test("buildPrompt includes skills, tool summary, memory, and user request", () => {
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(parseSkillMarkdown(`---
name: triage_incident
description: incident flow
promptRole: developer
---

use facts first`));
  const selected = skillRegistry.select(["triage_incident"]);
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  assert.equal(selected.ok, true);

  const prompt = buildPrompt({
    globalPolicy: "global policy",
    userRequest: "investigate checkout",
    activeSkills: selected.skills,
    toolSummary: "- lookup_service_status: status lookup",
    stateSummary: "sev-2",
    memorySummary: "recent deploy",
  });

  assert.equal(prompt.activeSkillIds[0], "triage_incident");
  assert.equal(prompt.messages.at(-1)?.role, "user");
  assert.match(prompt.messages.map((message) => message.content).join("\n"), /recent deploy/);
});

test("getVisibleToolNames respects allowedTools on active skills", () => {
  const skill = parseSkillMarkdown(`---
name: triage_incident
description: incident flow
promptRole: developer
allowedTools: lookup_service_status
---

facts first`);

  const visible = getVisibleToolNames([{
    name: skill.name,
    description: skill.description,
    promptRole: skill.promptRole ?? "developer",
    instruction: skill.instruction,
    metadata: skill.metadata,
  }], ["lookup_service_status", "summarize_note_chunk"]);

  assert.deepEqual(visible, ["lookup_service_status"]);
});

test("runAgentLoop executes tool calls and returns final output", async () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(defineTool({
    name: "lookup_service_status",
    description: "status lookup",
    inputSchema: s.object(
      { service: s.string({ minLength: 1 }) },
      { required: ["service"] },
    ),
    execute: ({ service }) => ({ service, status: "degraded" }),
  }));

  const skillRegistry = new SkillRegistry();
  skillRegistry.register(parseSkillMarkdown(`---
name: triage_incident
description: incident flow
promptRole: developer
---

facts first`));

  class FakeModel implements AgentModel {
    private turn = 0;

    generate(input: { messages: AgentMessage[] }): ModelTurnResponse {
      this.turn += 1;
      if (this.turn === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              name: "lookup_service_status",
              input: { service: "checkout" },
            },
          ],
        };
      }

      const toolMessage = input.messages.find((message) => message.role === "tool");
      return {
        type: "final",
        outputText: `final from ${toolMessage?.content ?? "none"}`,
      };
    }
  }

  const result = await runAgentLoop({
    model: new FakeModel(),
    toolRegistry,
    skillRegistry,
    skillRouter: new ManualSkillRouter(["triage_incident"]),
    globalPolicy: "global policy",
    userRequest: "investigate checkout",
  });

  assert.equal(result.activeSkillIds[0], "triage_incident");
  assert.equal(result.toolResults.length, 1);
  assert.deepEqual(result.visibleToolNames, ["lookup_service_status"]);
  assert.match(result.finalOutput, /lookup_service_status/);
});
