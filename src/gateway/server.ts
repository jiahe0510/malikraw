import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadRuntimeConfig } from "../core/config/agent-config.js";
import { createAgentRuntime } from "../runtime/create-agent-runtime.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const runtime = await createAgentRuntime(config);

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        return sendJson(response, 400, { error: "Missing URL." });
      }

      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, {
          ok: true,
          workspaceRoot: runtime.workspaceRoot,
          activeSkills: config.activeSkillIds,
        });
      }

      if (request.method === "POST" && request.url === "/api/chat") {
        const body = await readJsonBody(request);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          return sendJson(response, 400, { error: 'Field "message" is required.' });
        }

        const result = await runtime.ask(message);
        return sendJson(response, 200, {
          ok: true,
          output: result.output,
          visibleToolNames: result.visibleToolNames,
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
    console.log(`workspace: ${runtime.workspaceRoot}`);
  });
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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
