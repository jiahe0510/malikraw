import {
  ManualSkillRouter,
  OpenAICompatibleModel,
  SkillRegistry,
  ToolRegistry,
  defineSkill,
  defineTool,
  loadAppConfig,
  runAgentLoop,
  s,
} from "./index.js";

const env = readEnv();

async function main(): Promise<void> {
  const config = loadAppConfig(env, getArgv());
  const toolRegistry = createToolRegistry();
  const skillRegistry = createSkillRegistry();
  const model = new OpenAICompatibleModel(config.model);

  const result = await runAgentLoop({
    model,
    toolRegistry,
    skillRegistry,
    skillRouter: new ManualSkillRouter(config.activeSkillIds),
    globalPolicy: config.globalPolicy,
    userRequest: config.userRequest,
    stateSummary: config.stateSummary,
    memorySummary: config.memorySummary,
    maxIterations: config.maxIterations,
  });

  console.log(result.finalOutput);
}

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(defineTool({
    name: "lookup_service_status",
    description: "Look up the current status of a named service.",
    inputSchema: s.object(
      {
        service: s.string({ minLength: 1 }),
      },
      { required: ["service"] },
    ),
    execute: async ({ service }) => {
      const serviceName = service.toLowerCase();
      if (serviceName === "payments" || serviceName === "checkout") {
        return {
          service,
          status: "degraded",
          suspectedCause: "Recent deploy increased timeout rates.",
        };
      }

      return {
        service,
        status: "healthy",
        suspectedCause: null,
      };
    },
  }));

  registry.register(defineTool({
    name: "summarize_note_chunk",
    description: "Summarize a note chunk into key decisions, open questions, and actions.",
    inputSchema: s.object(
      {
        note: s.string({ minLength: 1 }),
      },
      { required: ["note"] },
    ),
    execute: ({ note }) => ({
      summary: note.slice(0, 240),
    }),
  }));

  return registry;
}

function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();

  registry.register(defineSkill({
    name: "triage_incident",
    description: "Triage production incidents with impact-first investigation.",
    instruction: `
Focus on impact, mitigation, and the next best diagnostic step.
Prefer tool use before speculation.
Call out user-visible impact, blast radius, and rollback options explicitly.
`,
  }));

  registry.register(defineSkill({
    name: "summarize_notes",
    description: "Summarize working notes into durable decisions and action items.",
    instruction: `
Extract decisions, unresolved questions, and follow-up actions.
Compress noise aggressively and avoid repeating raw notes verbatim.
Preserve chronology only when it changes meaning.
`,
  }));

  return registry;
}

function readEnv(): Record<string, string | undefined> {
  return getProcess().env;
}

function getArgv(): string[] {
  return getProcess().argv.slice(2);
}

function getProcess(): { env: Record<string, string | undefined>; argv: string[] } {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined>; argv: string[] };
  };

  if (!maybeProcess.process) {
    throw new Error("Node.js process object is not available.");
  }

  return maybeProcess.process;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  exitProcess(1);
});

function exitProcess(code: number): void {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { exit?: (exitCode?: number) => never };
  };

  maybeProcess.process?.exit?.(code);
}
