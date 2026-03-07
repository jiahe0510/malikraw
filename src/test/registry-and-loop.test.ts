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
name: workspace_operator
description: workspace flow
promptRole: developer
allowedTools: read_file, edit_file
---

read before edit`));
  const selected = skillRegistry.select(["workspace_operator"]);
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  assert.equal(selected.ok, true);

  const prompt = buildPrompt({
    globalPolicy: "global policy",
    agentSystemContent: "# Agent Capabilities\n\nCan inspect workspace files.",
    userRequest: "update a file",
    activeSkills: selected.skills,
    toolSummary: "- read_file: read file\n- edit_file: edit file",
    stateSummary: "sev-2",
    memorySummary: "recent deploy",
  });

  assert.equal(prompt.activeSkillIds[0], "workspace_operator");
  assert.equal(prompt.messages.at(-1)?.role, "user");
  assert.match(prompt.messages.map((message) => message.content).join("\n"), /recent deploy/);
  assert.match(prompt.messages.map((message) => message.content).join("\n"), /Agent Capabilities/);
  assert.match(prompt.messages.map((message) => message.content).join("\n"), /Runtime Context/);
  assert.match(prompt.messages.map((message) => message.content).join("\n"), /Active Skills/);
  assert.doesNotMatch(prompt.messages.map((message) => message.content).join("\n"), /<skill name=/);
});

test("getVisibleToolNames respects allowedTools on active skills", () => {
  const skill = parseSkillMarkdown(`---
name: workspace_operator
description: workspace flow
promptRole: developer
allowedTools: read_file, edit_file
---

read before edit`);

  const visible = getVisibleToolNames([{
    name: skill.name,
    description: skill.description,
    promptRole: skill.promptRole ?? "developer",
    instruction: skill.instruction,
    metadata: skill.metadata,
  }], ["read_file", "edit_file", "exec_shell"]);

  assert.deepEqual(visible, ["read_file", "edit_file"]);
});

test("runAgentLoop executes tool calls and returns final output", async () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(defineTool({
    name: "read_file",
    description: "read a file",
    inputSchema: s.object(
      { path: s.string({ minLength: 1 }) },
      { required: ["path"] },
    ),
    execute: ({ path }) => ({ path, content: "hello" }),
  }));

  const skillRegistry = new SkillRegistry();
  skillRegistry.register(parseSkillMarkdown(`---
name: workspace_operator
description: workspace flow
promptRole: developer
allowedTools: read_file
---

read before edit`));

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
              name: "read_file",
              input: { path: "README.md" },
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
    skillRouter: new ManualSkillRouter(["workspace_operator"]),
    globalPolicy: "global policy",
    userRequest: "read a file",
  });

  assert.equal(result.activeSkillIds[0], "workspace_operator");
  assert.equal(result.toolResults.length, 1);
  assert.deepEqual(result.visibleToolNames, ["read_file"]);
  assert.match(result.finalOutput, /read_file/);
});
