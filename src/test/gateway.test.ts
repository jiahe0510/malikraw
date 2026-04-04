import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Gateway, type AgentMessage, type AgentRuntime, type ChannelDelivery, type GatewayChannel } from "../index.js";
import { FileBackedSessionStore, compactSessionMessages } from "../gateway/session-store.js";

test("gateway routes messages through channel and persists session history", async () => {
  const deliveries: ChannelDelivery[] = [];
  const runtimeCalls: { userRequest: string; history?: AgentMessage[] }[] = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => {
      runtimeCalls.push({ userRequest, history });
      const messages: AgentMessage[] = [
        ...(history ?? []),
        { role: "user", content: userRequest },
        { role: "assistant", content: `reply:${userRequest}` },
      ];

      return {
        output: `reply:${userRequest}`,
        visibleToolNames: ["read_file"],
        messages,
        media: [],
        messageDispatches: [],
      };
    },
  };

  const channel: GatewayChannel = {
    id: "tui",
    sendMessage: (delivery) => {
      deliveries.push(delivery);
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel(channel);

  await gateway.handleMessage({
    session: {
      channelId: "tui",
      sessionId: "session-1",
    },
    content: "hello",
  });

  await gateway.handleMessage({
    session: {
      channelId: "tui",
      sessionId: "session-1",
    },
    content: "again",
  });

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0]?.content, "reply:hello");
  assert.equal(deliveries[1]?.content, "reply:again");
  assert.equal(runtimeCalls.length, 2);
  assert.equal(runtimeCalls[0]?.history?.length ?? 0, 0);
  assert.equal(runtimeCalls[1]?.history?.length, 2);
  assert.deepEqual(
    runtimeCalls[1]?.history?.map((message) => `${message.role}:${message.content}`),
    ["user:hello", "assistant:reply:hello"],
  );
});

test("gateway isolates sessions by channel and session id", async () => {
  const seenHistories: Array<string[]> = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => {
      seenHistories.push((history ?? []).map((message) => message.content));
      return {
        output: userRequest,
        visibleToolNames: [],
        messages: [
          ...(history ?? []),
          { role: "user", content: userRequest },
          { role: "assistant", content: userRequest },
        ],
        media: [],
        messageDispatches: [],
      };
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "tui",
    sendMessage: () => {},
  });

  await gateway.handleMessage({
    session: { agentId: "alpha", channelId: "tui", sessionId: "one" },
    content: "a",
  });
  await gateway.handleMessage({
    session: { agentId: "alpha", channelId: "tui", sessionId: "two" },
    content: "b",
  });
  await gateway.handleMessage({
    session: { agentId: "alpha", channelId: "tui", sessionId: "one" },
    content: "c",
  });

  assert.deepEqual(seenHistories, [
    [],
    [],
    ["a", "a"],
  ]);
});

test("gateway isolates sessions by agent id", async () => {
  const seenHistories: Array<string[]> = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => {
      seenHistories.push((history ?? []).map((message) => message.content));
      return {
        output: userRequest,
        visibleToolNames: [],
        messages: [
          ...(history ?? []),
          { role: "user", content: userRequest },
          { role: "assistant", content: userRequest },
        ],
        media: [],
        messageDispatches: [],
      };
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "feishu",
    sendMessage: () => {},
  });

  await gateway.handleMessage({
    session: { agentId: "planner", channelId: "feishu", sessionId: "thread-1" },
    content: "a",
  });
  await gateway.handleMessage({
    session: { agentId: "executor", channelId: "feishu", sessionId: "thread-1" },
    content: "b",
  });
  await gateway.handleMessage({
    session: { agentId: "planner", channelId: "feishu", sessionId: "thread-1" },
    content: "c",
  });

  assert.deepEqual(seenHistories, [
    [],
    [],
    ["a", "a"],
  ]);
});

test("gateway passes structured media through to channels", async () => {
  const deliveries: ChannelDelivery[] = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => ({
      output: `reply:${userRequest}`,
      visibleToolNames: [],
      messages: [
        ...(history ?? []),
        { role: "user", content: userRequest },
        { role: "assistant", content: `reply:${userRequest}` },
      ],
      media: [
        { kind: "file", path: "artifacts/report.pdf" },
        { kind: "image", path: "artifacts/chart.png" },
      ],
      messageDispatches: [],
    }),
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "feishu",
    sendMessage: (delivery) => {
      deliveries.push(delivery);
    },
  });

  await gateway.handleMessage({
    session: { channelId: "feishu", sessionId: "session-1" },
    content: "send report",
  });

  assert.deepEqual(deliveries[0]?.media, [
    { kind: "file", path: "artifacts/report.pdf" },
    { kind: "image", path: "artifacts/chart.png" },
  ]);
});

test("gateway forwards runtime events to channels that opt in", async () => {
  const eventTypes: string[] = [];
  const deliveries: ChannelDelivery[] = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async () => {
      throw new Error("ask should not be used when askEvents is available");
    },
    askEvents: async function* ({ userRequest, history }) {
      yield {
        type: "prompt_ready",
        queryContext: {
          instructionMessages: [],
          userContext: {},
          systemContext: {},
          history: history ?? [],
          userRequest,
          activeSkillIds: [],
        },
        prompt: {
          messages: history ?? [],
          activeSkillIds: [],
        },
        visibleToolNames: ["read_file"],
      };
      yield {
        type: "assistant_message",
        iteration: 0,
        message: { role: "assistant", content: "working" },
      };
      yield {
        type: "final_output",
        iteration: 0,
        message: { role: "assistant", content: "done" },
        output: "done",
      };

      return {
        output: "done",
        visibleToolNames: ["read_file"],
        messages: [
          { role: "user", content: userRequest },
          { role: "assistant", content: "done" },
        ],
        media: [],
        messageDispatches: [],
      };
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "tui",
    handleRuntimeEvent: ({ event }) => {
      eventTypes.push(event.type);
    },
    sendMessage: (delivery) => {
      deliveries.push(delivery);
    },
  });

  await gateway.handleMessage({
    session: { channelId: "tui", sessionId: "session-1" },
    content: "hello",
  });

  assert.deepEqual(eventTypes, ["prompt_ready", "assistant_message", "final_output"]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.content, "done");
});

test("gateway appends inbound attachment paths to the runtime user request", async () => {
  const runtimeCalls: { userRequest: string }[] = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => {
      runtimeCalls.push({ userRequest });
      return {
        output: "ok",
        visibleToolNames: [],
        messages: [
          ...(history ?? []),
          { role: "user", content: userRequest },
          { role: "assistant", content: "ok" },
        ],
        media: [],
        messageDispatches: [],
      };
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "feishu",
    sendMessage: () => {},
  });

  await gateway.handleMessage({
    session: { channelId: "feishu", sessionId: "session-1" },
    content: "请阅读附件",
    media: [
      { kind: "file", path: "/workspace/.runtime/feishu/inbound/a/report.md" },
      { kind: "image", path: "/workspace/.runtime/feishu/inbound/a/chart.png" },
    ],
  });

  assert.equal(
    runtimeCalls[0]?.userRequest,
    "请阅读附件\n\nAttachments:\n- /workspace/.runtime/feishu/inbound/a/report.md\n- /workspace/.runtime/feishu/inbound/a/chart.png",
  );
});

test("gateway dispatches structured message tool outputs through the target channel", async () => {
  const deliveries: ChannelDelivery[] = [];

  const runtime: AgentRuntime = {
    workspaceRoot: "/tmp/workspace",
    ask: async ({ userRequest, history }) => ({
      output: `reply:${userRequest}`,
      visibleToolNames: [],
      messages: [
        ...(history ?? []),
        { role: "user", content: userRequest },
        { role: "assistant", content: `reply:${userRequest}` },
      ],
      media: [],
      messageDispatches: [{
        content: "sent via tool",
        media: [{ kind: "image", path: "/tmp/chart.png" }],
      }],
    }),
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "feishu",
    sendMessage: (delivery) => {
      deliveries.push(delivery);
    },
  });

  await gateway.handleMessage({
    session: { agentId: "main", channelId: "feishu", sessionId: "session-1" },
    content: "send chart",
  });

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0]?.content, "sent via tool");
  assert.deepEqual(deliveries[0]?.media, [{ kind: "image", path: "/tmp/chart.png" }]);
  assert.equal(deliveries[1]?.content, "reply:send chart");
});

test("compactSessionMessages keeps a summary plus recent messages", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];

  const compacted = compactSessionMessages(messages, {
    maxRecentMessages: 4,
    maxSummaryChars: 200,
  });

  assert.equal(compacted.length, 5);
  assert.equal(compacted[0]?.role, "user");
  assert.match(compacted[0]?.content ?? "", /^\[compacted_history\]/);
  assert.deepEqual(
    compacted.slice(1).map((message) => message.content),
    ["u2", "a2", "u3", "a3"],
  );
});

test("compactSessionMessages keeps recent history aligned to a user message boundary", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "tool", toolName: "read_file", content: "{\"ok\":true}" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "tool", toolName: "read_file", content: "{\"ok\":true}" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];

  const compacted = compactSessionMessages(messages, {
    maxRecentMessages: 4,
    maxSummaryChars: 200,
  });

  assert.equal(compacted[1]?.role, "user");
  assert.deepEqual(
    compacted.slice(1).map((message) => `${message.role}:${message.content}`),
    ["user:u3", "assistant:a3"],
  );
});

test("compactSessionMessages keeps recent tool messages and summarizes older tool calls lightly", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "tool", toolName: "read_file", content: "{\"path\":\"README.md\"}" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ];

  const compacted = compactSessionMessages(messages, {
    maxRecentMessages: 2,
    maxSummaryChars: 200,
  });

  assert.equal(compacted[0]?.role, "user");
  assert.match(compacted[0]?.content ?? "", /tool read_file: recorded result/);
  assert.deepEqual(
    compacted.slice(1).map((message) => `${message.role}:${message.content}`),
    ["user:u2", "assistant:a2"],
  );
});

test("compactSessionMessages compacts when total history chars exceed threshold even with few messages", () => {
  const longText = "x".repeat(5000);
  const compacted = compactSessionMessages([
    { role: "user", content: longText },
    { role: "assistant", content: "ok" },
  ], {
    maxRecentMessages: 8,
    maxSummaryChars: 200,
    maxHistoryChars: 1000,
  });

  assert.equal(compacted[0]?.role, "user");
  assert.match(compacted[0]?.content ?? "", /^\[compacted_history\]/);
});

test("FileBackedSessionStore preserves session history across store instances", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "malikraw-sessions-"));
  const session = {
    agentId: "primary",
    channelId: "feishu",
    sessionId: "thread-1",
  };

  const firstStore = new FileBackedSessionStore({ directory });
  await firstStore.write(session, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);

  const secondStore = new FileBackedSessionStore({ directory });
  const history = await secondStore.read(session);

  assert.deepEqual(history, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
});
