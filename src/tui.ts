import readline from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { loadRuntimeConfig } from "./core/config/agent-config.js";
import { Gateway, createA2ATaskService, createAgentRuntime, type ChannelDelivery, type GatewayChannel } from "./index.js";

export async function runTui(): Promise<void> {
  const config = loadRuntimeConfig();
  const runtime = await createAgentRuntime(config);
  const runtimes = await createAgentRuntimeMap(config);
  const taskService = createA2ATaskService(config, runtimes);
  const gateway = new Gateway(runtime);
  const channel = createTuiChannel();
  gateway.registerChannel(channel);
  const rl = readline.createInterface({ input, output });
  const sessionId = "default";
  const agentId = config.defaultAgentId;

  console.log(`malikraw tui registered to gateway channel tui for agent ${agentId}`);
  console.log('Type a request, "/task help" for A2A task commands, or "/exit" to exit.');

  while (true) {
    const question = await rl.question("> ");
    const trimmed = question.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "/exit") {
      break;
    }

    try {
      if (trimmed.startsWith("/task")) {
        const response = await handleTaskCommand(trimmed, taskService);
        console.log("");
        console.log(response);
        console.log("");
        continue;
      }

      await gateway.handleMessage({
        session: {
          agentId,
          channelId: channel.id,
          sessionId,
        },
        content: trimmed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    }
  }

  rl.close();
}

function createTuiChannel(): GatewayChannel {
  return {
    id: "tui",
    sendMessage: (delivery: ChannelDelivery) => {
      console.log("");
      console.log(delivery.content);
      console.log("");
    },
  };
}

async function createAgentRuntimeMap(config: ReturnType<typeof loadRuntimeConfig>) {
  const runtimes = new Map<string, Awaited<ReturnType<typeof createAgentRuntime>>>();
  for (const agent of config.agents) {
    const runtime = await createAgentRuntime({
      ...config,
      model: agent.model,
      activeSkillIds: agent.activeSkillIds,
    });
    runtimes.set(agent.id, runtime);
  }
  return runtimes;
}

async function handleTaskCommand(
  inputValue: string,
  taskService: ReturnType<typeof createA2ATaskService>,
): Promise<string> {
  const [, command = "help", ...rest] = inputValue.split(" ");

  if (command === "help") {
    return [
      "/task commands:",
      "/task list",
      "/task run <natural language>",
      "/task get <rootTaskId>",
      "/task steps <rootTaskId>",
      "/task events <rootTaskId>",
      '/task create <json>',
    ].join("\n");
  }

  if (command === "list") {
    const tasks = await taskService.listTasks();
    return JSON.stringify({ ok: true, tasks }, null, 2);
  }

  if (command === "run") {
    const requestText = rest.join(" ").trim();
    if (!requestText) {
      throw new Error('Usage: /task run <natural language>');
    }
    const created = await taskService.planAndCreateTask(requestText);
    return JSON.stringify(created, null, 2);
  }

  if (command === "get") {
    const rootTaskId = rest.join(" ").trim();
    if (!rootTaskId) {
      throw new Error('Usage: /task get <rootTaskId>');
    }
    const task = await taskService.getTask(rootTaskId);
    return JSON.stringify(task ? { ok: true, task } : { ok: false, error: `Task "${rootTaskId}" not found.` }, null, 2);
  }

  if (command === "steps") {
    const rootTaskId = rest.join(" ").trim();
    if (!rootTaskId) {
      throw new Error('Usage: /task steps <rootTaskId>');
    }
    const steps = await taskService.listSteps(rootTaskId);
    return JSON.stringify(steps ? { ok: true, rootTaskId, steps } : { ok: false, error: `Task "${rootTaskId}" not found.` }, null, 2);
  }

  if (command === "events") {
    const rootTaskId = rest.join(" ").trim();
    if (!rootTaskId) {
      throw new Error('Usage: /task events <rootTaskId>');
    }
    const events = await taskService.listEvents(rootTaskId);
    return JSON.stringify(events ? { ok: true, rootTaskId, events } : { ok: false, error: `Task "${rootTaskId}" not found.` }, null, 2);
  }

  if (command === "create") {
    const json = rest.join(" ").trim();
    if (!json) {
      throw new Error('Usage: /task create <json>');
    }
    const payload = JSON.parse(json) as Record<string, unknown>;
    const created = await taskService.createTask(payload);
    return JSON.stringify(created, null, 2);
  }

  throw new Error(`Unknown /task command "${command}". Use "/task help".`);
}

if (isDirectExecution()) {
  void runTui().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return import.meta.url === new URL(`file://${path.resolve(entryPath)}`).href;
}
