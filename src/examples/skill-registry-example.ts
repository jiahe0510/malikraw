import {
  SkillRegistry,
  defineSkill,
  injectSkillPromptBlocks,
  renderSkillPromptBlocks,
  type PromptMessage,
} from "../index.js";

const triageIncident = defineSkill({
  name: "triage_incident",
  description: "Drive an incident triage workflow with fast narrowing and risk-first communication.",
  promptRole: "developer",
  instruction: `
Prioritize service restoration over cleanup.
State current hypothesis, missing evidence, and next diagnostic step.
Prefer bounded tool calls that reduce uncertainty in one step.
Surface user-visible impact, likely blast radius, and rollback options before deep optimization.
`,
});

const summarizeNotes = defineSkill({
  name: "summarize_notes",
  description: "Turn noisy notes into a stable summary with decisions, open questions, and action items.",
  promptRole: "developer",
  instruction: `
Extract decisions, unresolved questions, and follow-up actions.
Preserve chronology only when it affects meaning.
Avoid repeating raw notes; compress into durable takeaways.
`,
});

function main(): void {
  const registry = new SkillRegistry();
  registry.register(triageIncident);
  registry.register(summarizeNotes);

  const selected = registry.select(["triage_incident"]);
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }

  const baseMessages: PromptMessage[] = [
    {
      role: "system",
      content: "You are an agent core runtime.",
    },
    {
      role: "developer",
      content: "Use registered tools and follow runtime constraints.",
    },
  ];

  const injected = injectSkillPromptBlocks(baseMessages, selected.skills);
  const blocks = renderSkillPromptBlocks(selected.skills);

  console.log(JSON.stringify({ selected, blocks, injected }, null, 2));
}

main();
