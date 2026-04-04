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
    memorySystemContent: "# Memory\n\nUser prefers concise replies.",
    userContext: {
      "Current Date": "2026-04-04",
    },
    systemContext: {
      Channel: "feishu",
    },
    userRequest: "update a file",
    activeSkills: selected.skills,
    toolSummary: "- read_file: read file\n- edit_file: edit file",
    stateSummary: "sev-2",
    memorySummary: "recent deploy",
    relevantMemoryBlock: "[Relevant Memory]\nStable facts:\n- User prefers concise replies.",
  });

  assert.equal(prompt.activeSkillIds[0], "workspace_operator");
  assert.equal(prompt.messages.at(-1)?.role, "user");
  const content = prompt.messages.map((message) => message.content).join("\n");
  assert.match(content, /recent deploy/);
  assert.match(content, /Identity/);
  assert.match(content, /Personality/);
  assert.match(content, /Agent Capabilities/);
  assert.match(content, /User prefers concise replies/);
  assert.match(content, /Runtime Context/);
  assert.match(content, /<system-reminder>/);
  assert.match(content, /Current Date/);
  assert.match(content, /\[Relevant Memory\]/);
  assert.match(content, /Active Skills/);
  assert.match(content, /edit_file|write_file/);
  assert.doesNotMatch(content, /<skill name=/);

  assert.equal(prompt.messages[0]?.role, "system");
  assert.equal(prompt.messages[0]?.content, "global policy");
  assert.equal(prompt.messages[1]?.role, "system");
  assert.match(prompt.messages[1]?.content ?? "", /Identity/);
  assert.equal(prompt.messages[2]?.role, "system");
  assert.match(prompt.messages[2]?.content ?? "", /Personality/);
  assert.equal(prompt.messages[3]?.role, "system");
  assert.match(prompt.messages[3]?.content ?? "", /Workspace AGENT\.md/);
  assert.equal(prompt.messages[4]?.role, "developer");
  assert.match(prompt.messages[4]?.content ?? "", /System context:/);
  assert.match(prompt.messages[4]?.content ?? "", /Channel: feishu/);
  assert.equal(prompt.messages[5]?.role, "developer");
  assert.match(prompt.messages[5]?.content ?? "", /Active Skills/);
  assert.equal(prompt.messages[6]?.role, "user");
  assert.match(prompt.messages[6]?.content ?? "", /<system-reminder>/);
});

test("buildPrompt omits retrieved memory section when none is injected", () => {
  const prompt = buildPrompt({
    globalPolicy: "global policy",
    userRequest: "hi",
    activeSkills: [],
    toolSummary: "- search_memory: search stored memory",
    stateSummary: "none",
    memorySummary: "none",
  });

  const content = prompt.messages.map((message) => message.content).join("\n");
  assert.doesNotMatch(content, /Retrieved memory:/);
  assert.doesNotMatch(content, /<system-reminder>/);
});

test("buildPrompt rewrites legacy assistant session summary into a synthetic user history message", () => {
  const prompt = buildPrompt({
    globalPolicy: "global policy",
    userRequest: "current question",
    activeSkills: [],
    toolSummary: "No tools are currently available.",
    history: [
      {
        role: "assistant",
        content: "[session_summary]\nuser: old question\nassistant: old answer",
      },
      {
        role: "user",
        content: "follow up",
      },
      {
        role: "assistant",
        content: "answer",
      },
    ],
  });

  const joined = prompt.messages.map((message) => `${message.role}:${message.content}`).join("\n");
  assert.match(joined, /user:\[compacted_history\]/);
  assert.doesNotMatch(joined, /assistant:\[session_summary\]/);
  assert.match(joined, /user:follow up/);
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

test("runAgentLoop retries after reactive compaction on context length errors", async () => {
  class ReactiveModel implements AgentModel {
    calls = 0;

    async generate(input: { messages: AgentMessage[] }): Promise<ModelTurnResponse> {
      this.calls += 1;
      if (this.calls === 1) {
        assert.equal(input.messages.at(0)?.role, "system");
        throw Object.assign(new Error("maximum context length exceeded"), {
          contextLengthExceeded: true,
        });
      }

      assert.equal(input.messages.at(0)?.role, "system");
      assert.match(input.messages[1]?.content ?? "", /^\[compacted_history\]/);
      return {
        type: "final",
        outputText: "done after compact",
      };
    }
  }

  const model = new ReactiveModel();
  const result = await runAgentLoop({
    model,
    toolRegistry: new ToolRegistry(),
    skillRegistry: new SkillRegistry(),
    skillRouter: new ManualSkillRouter([]),
    globalPolicy: "global policy",
    userRequest: "latest request",
    history: [
      { role: "user", content: "old question " + "x".repeat(4000) },
      { role: "assistant", content: "old answer " + "y".repeat(4000) },
    ],
    reactiveCompact: ({ messages }) => [
      messages[0]!,
      { role: "user", content: "[compacted_history]\nCurrent State\n- latest handoff" },
      { role: "user", content: "latest request" },
    ],
  });

  assert.equal(model.calls, 2);
  assert.equal(result.finalOutput, "done after compact");
});
