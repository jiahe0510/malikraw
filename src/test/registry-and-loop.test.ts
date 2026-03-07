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
    identitySystemContent: "# Identity\n\nYou are Malikraw.",
    personalitySystemContent: "# Personality\n\nBe direct.",
    agentSystemContent: "# Agent Capabilities\n\nCan inspect workspace files.",
    userRequest: "update a file",
    activeSkills: selected.skills,
    toolSummary: "- read_file: read file\n- edit_file: edit file",
    stateSummary: "sev-2",
    memorySummary: "recent deploy",
  });

  assert.equal(prompt.activeSkillIds[0], "workspace_operator");
  assert.equal(prompt.messages.at(-1)?.role, "user");
  const content = prompt.messages.map((message) => message.content).join("\n");
  assert.match(content, /recent deploy/);
  assert.match(content, /Identity/);
  assert.match(content, /Personality/);
  assert.match(content, /Agent Capabilities/);
  assert.match(content, /Runtime Context/);
  assert.match(content, /Active Skills/);
  assert.doesNotMatch(content, /<skill name=/);

  assert.equal(prompt.messages[0]?.role, "system");
  assert.equal(prompt.messages[0]?.content, "global policy");
  assert.equal(prompt.messages[1]?.role, "system");
  assert.match(prompt.messages[1]?.content ?? "", /Identity/);
  assert.equal(prompt.messages[2]?.role, "system");
  assert.match(prompt.messages[2]?.content ?? "", /Personality/);
  assert.equal(prompt.messages[3]?.role, "system");
  assert.match(prompt.messages[3]?.content ?? "", /Workspace AGENT\.md/);
});

test("getVisibleToolNames keeps all tools visible even when skills declare allowedTools", () => {
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

  assert.deepEqual(visible, ["read_file", "edit_file", "exec_shell"]);
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

test("runAgentLoop exposes non-skill tools to the model by default", async () => {
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
  toolRegistry.register(defineTool({
    name: "web_search",
    description: "search the web",
    inputSchema: s.object(
      { query: s.string({ minLength: 1 }) },
      { required: ["query"] },
    ),
    execute: ({ query }) => ({ query, results: [] }),
  }));

  const skillRegistry = new SkillRegistry();
  skillRegistry.register(parseSkillMarkdown(`---
name: workspace_operator
description: workspace flow
promptRole: developer
allowedTools: read_file
---

read before edit`));

  class FinalOnlyModel implements AgentModel {
    seenTools: string[] = [];

    generate(input: { messages: AgentMessage[]; tools: Array<{ function: { name: string } }> }): ModelTurnResponse {
      this.seenTools = input.tools.map((tool) => tool.function.name);
      return {
        type: "final",
        outputText: "done",
      };
    }
  }

  const model = new FinalOnlyModel();
  const result = await runAgentLoop({
    model,
    toolRegistry,
    skillRegistry,
    skillRouter: new ManualSkillRouter(["workspace_operator"]),
    globalPolicy: "global policy",
    userRequest: "search if needed",
  });

  assert.deepEqual(model.seenTools, ["read_file", "web_search"]);
  assert.deepEqual(result.visibleToolNames, ["read_file", "web_search"]);
});
