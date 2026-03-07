import test from "node:test";
import assert from "node:assert/strict";

import { Gateway, type AgentMessage, type AgentRuntime, type ChannelDelivery, type GatewayChannel } from "../index.js";

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
      };
    },
  };

  const gateway = new Gateway(runtime);
  gateway.registerChannel({
    id: "tui",
    sendMessage: () => {},
  });

  await gateway.handleMessage({
    session: { channelId: "tui", sessionId: "one" },
    content: "a",
  });
  await gateway.handleMessage({
    session: { channelId: "tui", sessionId: "two" },
    content: "b",
  });
  await gateway.handleMessage({
    session: { channelId: "tui", sessionId: "one" },
    content: "c",
  });

  assert.deepEqual(seenHistories, [
    [],
    [],
    ["a", "a"],
  ]);
});
