import {
  ManualSkillRouter,
  OpenAICompatibleModel,
  SkillRegistry,
  ToolRegistry,
  loadSkillsFromDirectory,
  loadAppConfig,
  registerBuiltinTools,
  runAgentLoop,
} from "./index.js";
import path from "node:path";

const env = readEnv();

async function main(): Promise<void> {
  const config = loadAppConfig(env, getArgv());
  const toolRegistry = createToolRegistry();
  const skillRegistry = await createSkillRegistry();
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
  return registerBuiltinTools(registry);
}

async function createSkillRegistry(): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const skills = await loadSkillsFromDirectory(path.join(getProcess().cwd(), "skills"));
  for (const skill of skills) {
    registry.register(skill);
  }

  return registry;
}

function readEnv(): Record<string, string | undefined> {
  return getProcess().env;
}

function getArgv(): string[] {
  return getProcess().argv.slice(2);
}

function getProcess(): { env: Record<string, string | undefined>; argv: string[]; cwd: () => string } {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined>; argv: string[]; cwd: () => string };
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
