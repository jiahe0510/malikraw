import {
  ManualSkillRouter,
  SkillRegistry,
  ToolRegistry,
  buildPrompt,
  defineSkill,
  defineTool,
  runAgentLoop,
  s,
  type AgentMessage,
  type AgentModel,
  type ModelTurnResponse,
} from "../index.js";

const registry = new ToolRegistry();
registry.register(defineTool({
  name: "lookup_service_status",
  description: "Look up the current status of a service by service name.",
  inputSchema: s.object(
    {
      service: s.string({ minLength: 1 }),
    },
    { required: ["service"] },
  ),
  execute: ({ service }) => ({
    service,
    status: service === "payments" ? "degraded" : "healthy",
  }),
}));

const skillRegistry = new SkillRegistry();
skillRegistry.register(defineSkill({
  name: "triage_incident",
  description: "Triage production incidents with hypothesis-driven debugging.",
  instruction: `
Focus on impact, mitigation, and the next best diagnostic step.
Use tools to reduce uncertainty before proposing root cause.
`,
}));

class FakeModel implements AgentModel {
  private turn = 0;

  generate(input: { messages: AgentMessage[] }): ModelTurnResponse {
    this.turn += 1;

    if (this.turn === 1) {
      return {
        type: "tool_calls",
        assistantMessage: "I need the current service status first.",
        toolCalls: [
          {
            id: "call_1",
            name: "lookup_service_status",
            input: { service: "payments" },
          },
        ],
      };
    }

    const toolMessages = input.messages.filter((message) => message.role === "tool");
    const toolMessage = toolMessages[toolMessages.length - 1];
    return {
      type: "final",
      outputText: `Incident summary based on tool output: ${toolMessage?.content ?? "no tool output"}`,
    };
  }
}

async function main(): Promise<void> {
  const selectedSkills = skillRegistry.select(["triage_incident"]);
  if (!selectedSkills.ok) {
    throw new Error(selectedSkills.error.message);
  }

  const prompt = buildPrompt({
    globalPolicy: "Operate as a careful agent runtime. Prefer tools over guessing.",
    userRequest: "Investigate why checkout is failing.",
    activeSkills: selectedSkills.skills,
    toolSummary: registry.describeTools(),
    stateSummary: "Incident severity: SEV-2",
    memorySummary: "Recent deploy: checkout-service 10 minutes ago",
  });

  const result = await runAgentLoop({
    model: new FakeModel(),
    toolRegistry: registry,
    skillRegistry,
    skillRouter: new ManualSkillRouter(["triage_incident"]),
    globalPolicy: "Operate as a careful agent runtime. Prefer tools over guessing.",
    userRequest: "Investigate why checkout is failing.",
    stateSummary: "Incident severity: SEV-2",
    memorySummary: "Recent deploy: checkout-service 10 minutes ago",
  });

  console.log(JSON.stringify({ prompt, result, tools: registry.toModelTools() }, null, 2));
}

void main();
