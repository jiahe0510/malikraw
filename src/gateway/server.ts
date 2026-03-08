import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { loadRuntimeConfig } from "../core/config/agent-config.js";
import type { RuntimeConfig } from "../core/config/agent-config.js";
import { createAgentRuntime } from "../runtime/create-agent-runtime.js";
import { createConfiguredChannels } from "../channels/index.js";
import { Gateway } from "./gateway.js";
import { FileBackedSessionStore } from "./session-store.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  await startGatewayServer(config);
}

export async function startGatewayServer(config: RuntimeConfig): Promise<void> {
  const runtimes = await createAgentRuntimeMap(config);
  const defaultRuntime = requireRuntime(config.defaultAgentId, runtimes);
  const gateway = new Gateway(
    (agentId) => requireRuntime(agentId ?? config.defaultAgentId, runtimes),
    new FileBackedSessionStore(),
  );
  const channels = createConfiguredChannels(config);
  for (const channel of channels) {
    gateway.registerChannel(channel);
    console.log(
      `[gateway] registered channel id=${channel.id} kind=${describeChannel(config, channel.id)} agent=${resolveChannelAgent(config, channel.id)}`,
    );
  }
  for (const channel of channels) {
    await channel.start?.({
      handleMessage: async (message) => gateway.handleMessage(message),
    });
  }

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        return sendJson(response, 400, { error: "Missing URL." });
      }

      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, {
          ok: true,
          workspaceRoot: defaultRuntime.workspaceRoot,
          defaultAgentId: config.defaultAgentId,
          agents: config.agents.map((agent) => ({
            id: agent.id,
            activeSkillIds: agent.activeSkillIds,
          })),
          channels: gateway.listChannelIds(),
        });
      }

      if (request.method === "POST" && request.url === "/api/chat") {
        const body = await readJsonBody(request);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "http";
        const agentId = typeof body.agentId === "string" ? body.agentId.trim() : resolveChannelAgent(config, channelId);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "default";
        if (!message) {
          return sendJson(response, 400, { error: 'Field "message" is required.' });
        }

        const result = await gateway.handleMessage({
          session: {
            agentId,
            channelId,
            sessionId,
          },
          content: message,
        });
        return sendJson(response, 200, {
          ok: true,
          output: result.output,
          visibleToolNames: result.visibleToolNames,
          agentId,
          channelId,
          sessionId,
        });
      }

      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(response, 500, { error: message });
    }
  });

  server.listen(config.gatewayPort, "127.0.0.1", () => {
    console.log(`malikraw gateway listening on http://127.0.0.1:${config.gatewayPort}`);
    console.log(`workspace: ${defaultRuntime.workspaceRoot}`);
    console.log(`defaultAgent: ${config.defaultAgentId}`);
    console.log(`agents: ${config.agents.map((agent) => agent.id).join(", ")}`);
    console.log(`channels: ${gateway.listChannelIds().join(", ")}`);
  });
}

async function createAgentRuntimeMap(config: RuntimeConfig): Promise<Map<string, Awaited<ReturnType<typeof createAgentRuntime>>>> {
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

function requireRuntime(
  agentId: string,
  runtimes: Map<string, Awaited<ReturnType<typeof createAgentRuntime>>>,
) {
  const runtime = runtimes.get(agentId);
  if (!runtime) {
    throw new Error(`Agent "${agentId}" is not registered.`);
  }

  return runtime;
}

function resolveChannelAgent(config: RuntimeConfig, channelId: string): string {
  const configured = config.channels.find((channel) => channel.id === channelId);
  return configured?.agentId ?? config.defaultAgentId;
}

function describeChannel(config: RuntimeConfig, channelId: string): string {
  return config.channels.find((channel) => channel.id === channelId)?.type ?? "unknown";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
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
