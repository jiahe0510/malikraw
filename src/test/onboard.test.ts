import test from "node:test";
import assert from "node:assert/strict";

import { resolveDefaultChannelId } from "../cli/onboard.js";

test("resolveDefaultChannelId prefers feishu when available", () => {
  const channelId = resolveDefaultChannelId([
    { id: "http", type: "http", agentId: "main" },
    { id: "feishu", type: "feishu", appId: "a", appSecret: "b", agentId: "main" },
  ]);

  assert.equal(channelId, "feishu");
});

test("resolveDefaultChannelId falls back to first channel id", () => {
  const channelId = resolveDefaultChannelId([
    { id: "http", type: "http", agentId: "main" },
  ]);

  assert.equal(channelId, "http");
});
