import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compactContextIfNeeded } from "../runtime/context-compactor.js";
import { runAgentLoopEvents } from "../core/agent/run-agent-loop.js";
import { executeTool } from "../core/tool-registry/tool-executor.js";
import { s } from "../core/tool-registry/schema.js";
import { getRuntimeEventFilePath, getRuntimeLogFilePath } from "../core/observability/observability.js";
import { InMemoryMemoryItemStore } from "../memory/memory-item-store.js";
import { MemoryRetriever } from "../memory/memory-retriever.js";
import { DefaultMemoryService } from "../memory/memory-service.js";
import { InMemorySessionStateStore } from "../memory/session-store.js";
import { InMemoryToolChainMemoryStore } from "../memory/tool-chain-store.js";

test("observability writes compaction and tool call events to ~/.malikraw/log and ~/.malikraw/event", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-observability-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    await compactContextIfNeeded({
      model: {
        generate: async () => {
          throw new Error("model should not be called for micro compaction");
        },
      },
      modelConfig: {
        baseURL: "https://example.invalid/v1",
        apiKey: "dummy",
        model: "test-model",
        contextWindow: 8192,
        maxTokens: 1024,
        compact: {
          thresholdTokens: 1200,
          targetTokens: 800,
        },
      },
      globalPolicy: "system policy",
      history: [
        { role: "user", content: "inspect logs" },
        { role: "assistant", content: "reading logs" },
        { role: "tool", toolName: "read_file", content: "x".repeat(5000) },
        { role: "user", content: "what failed?" },
      ],
      userRequest: "continue",
    });

    await executeTool({
      toolName: "demo_tool",
      rawInput: { path: "src/app.ts" },
      traceLog: {
        record: () => {},
        list: () => [],
        clear: () => {},
      },
      tool: {
        name: "demo_tool",
        inputSchema: s.object(
          { path: s.string({ minLength: 1 }) },
          { required: ["path"] },
        ),
        execute: async () => ({ ok: true }),
      },
    });

    const logContent = await readFile(getRuntimeLogFilePath(), "utf8");
    const eventContent = await readFile(getRuntimeEventFilePath(), "utf8");

    assert.match(logContent, /context\.compact\.micro/);
    assert.match(logContent, /context\.compact/);
    assert.match(logContent, /tool\.start/);
    assert.match(logContent, /tool\.success/);

    const eventNames = eventContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);
    assert.ok(eventNames.includes("context.compact.micro"));
    assert.ok(eventNames.includes("context.compact"));
    assert.ok(eventNames.includes("tool.start"));
    assert.ok(eventNames.includes("tool.success"));
  } finally {
    restoreHome(previousHome);
  }
});

test("observability writes memory search and retrieve events", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-observability-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const context = {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
      projectId: "p1",
    };
    const sessionStore = new InMemorySessionStateStore();
    const itemStore = new InMemoryMemoryItemStore();
    const toolChainStore = new InMemoryToolChainMemoryStore();
    await itemStore.insert(context, {
      query: "how do we ship this",
      summary: "Shipping plan",
      content: "Cut scope and ship the stable API first.",
      scope: "project",
      importance: 0.9,
      confidence: 0.8,
      source: "task_summary",
    });
    await toolChainStore.insert(context, {
      query: "how do we ship this",
      assistantResponse: "Use read_file then edit_file.",
      toolChain: [
        {
          toolName: "read_file",
          ok: true,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 2,
        },
      ],
    });

    const service = new DefaultMemoryService(
      new MemoryRetriever(sessionStore, itemStore, toolChainStore, {
        baseURL: "https://example.invalid/v1",
        apiKey: "dummy",
        model: "test-model",
        contextWindow: 8192,
        maxTokens: 1024,
        compact: {
          thresholdTokens: 4096,
          targetTokens: 2048,
        },
      }),
      {
        write: async () => ({
          sessionState: undefined,
          memoryItemsWritten: 0,
          toolChainsWritten: 0,
          observations: {
            memoryItemsWritten: 0,
            toolChainsWritten: 0,
            memoryItemsRetrieved: 0,
            toolChainsRetrieved: 0,
            compiledChars: 0,
            estimatedTokens: 0,
          },
        }),
      } as never,
    );

    await service.retrieve({
      context,
      query: "ship this",
    });

    const eventNames = (await readFile(getRuntimeEventFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);

    assert.ok(eventNames.includes("memory.search.start"));
    assert.ok(eventNames.includes("memory.search.result"));
    assert.ok(eventNames.includes("memory.retrieve"));
  } finally {
    restoreHome(previousHome);
  }
});

test("observability writes context build events", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-observability-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const stream = runAgentLoopEvents({
      model: {
        generate: async () => ({
          type: "final",
          outputText: "done",
        }),
      },
      toolRegistry: {
        toModelTools: () => [],
        describeTools: () => "No tools are currently available.",
        has: () => false,
        execute: async () => {
          throw new Error("tool execution should not happen");
        },
      },
      skillRouter: {
        route: () => ({ activeSkillIds: [] }),
      },
      skillRegistry: {
        list: () => [],
        select: () => ({ ok: true, skills: [] }),
      },
      globalPolicy: "Follow the system policy.",
      userRequest: "hello",
    });

    while (true) {
      const next = await stream.next();
      if (next.done) {
        break;
      }
    }

    const eventNames = (await readFile(getRuntimeEventFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);
    assert.ok(eventNames.includes("context.build"));
  } finally {
    restoreHome(previousHome);
  }
});

test("observability reuses one trace id across query steps", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-observability-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const traceId = "qry_shared_trace";
    const context = {
      sessionId: "s1",
      userId: "u1",
      agentId: "a1",
      projectId: "p1",
      traceId,
    };
    const sessionStore = new InMemorySessionStateStore();
    const itemStore = new InMemoryMemoryItemStore();
    const toolChainStore = new InMemoryToolChainMemoryStore();
    await itemStore.insert(context, {
      query: "deploy this service",
      summary: "Deployment advice",
      content: "Deploy behind the existing gateway first.",
      scope: "project",
      importance: 0.9,
      confidence: 0.8,
      source: "task_summary",
    });

    const memoryService = new DefaultMemoryService(
      new MemoryRetriever(sessionStore, itemStore, toolChainStore, {
        baseURL: "https://example.invalid/v1",
        apiKey: "dummy",
        model: "test-model",
        contextWindow: 8192,
        maxTokens: 1024,
        compact: {
          thresholdTokens: 4096,
          targetTokens: 2048,
        },
      }),
      {
        write: async () => ({
          sessionState: undefined,
          memoryItemsWritten: 0,
          toolChainsWritten: 0,
          observations: {
            memoryItemsWritten: 0,
            toolChainsWritten: 0,
            memoryItemsRetrieved: 0,
            toolChainsRetrieved: 0,
            compiledChars: 0,
            estimatedTokens: 0,
          },
        }),
      } as never,
    );

    const stream = runAgentLoopEvents({
      traceId,
      model: {
        generate: async (input) => {
          const hasToolResult = input.messages.some((message) => message.role === "tool");
          if (!hasToolResult) {
            return {
              type: "tool_calls",
              toolCalls: [{
                id: "call_1",
                name: "search_memory",
                input: { query: "deploy this service" },
              }],
            };
          }

          return {
            type: "final",
            outputText: "done",
          };
        },
      },
      toolRegistry: {
        toModelTools: () => [{
          type: "function",
          function: {
            name: "search_memory",
            description: "search memory",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          },
        }],
        describeTools: () => "- search_memory: search stored memory",
        has: (toolName: string) => toolName === "search_memory",
        execute: async (_toolName: string, rawInput: unknown, options?: { traceId?: string }) => {
          const query = typeof (rawInput as { query?: unknown })?.query === "string"
            ? String((rawInput as { query: string }).query)
            : "";
          await memoryService.retrieve({
            context: { ...context, traceId: options?.traceId ?? traceId },
            query,
          });
          return {
            toolName: "search_memory",
            traceId: options?.traceId ?? traceId,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            ok: true,
            data: { query },
          };
        },
      },
      skillRouter: {
        route: () => ({ activeSkillIds: [] }),
      },
      skillRegistry: {
        list: () => [],
        select: () => ({ ok: true, skills: [] }),
      },
      globalPolicy: "Follow the system policy.",
      userRequest: "deploy this service",
    });

    while (true) {
      const next = await stream.next();
      if (next.done) {
        break;
      }
    }

    const events = (await readFile(getRuntimeEventFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const names = events
      .filter((event) => event.data?.traceId === traceId)
      .map((event) => event.name);

    assert.ok(names.includes("context.build"));
    assert.ok(names.includes("memory.search.start"));
    assert.ok(names.includes("memory.search.result"));
    assert.ok(names.includes("memory.retrieve"));
  } finally {
    restoreHome(previousHome);
  }
});

function restoreHome(previousHome: string | undefined): void {
  if (previousHome === undefined) {
    delete process.env.MALIKRAW_HOME;
    return;
  }

  process.env.MALIKRAW_HOME = previousHome;
}
