import test from "node:test";
import assert from "node:assert/strict";

import { extractFeishuText, rememberMessageId, toChannelInboundMessage } from "../channels/feishu-channel.js";

test("extractFeishuText returns trimmed text messages only", () => {
  assert.equal(extractFeishuText("text", JSON.stringify({ text: " hello " })), "hello");
  assert.equal(extractFeishuText("image", JSON.stringify({ image_key: "abc" })), undefined);
});

test("toChannelInboundMessage maps Feishu event metadata into a channel session", () => {
  const message = toChannelInboundMessage({
    id: "feishu",
    agentId: "planner",
  }, {
    sender: {
      sender_type: "user",
    },
    message: {
      message_id: "om_xxx",
      chat_id: "oc_xxx",
      thread_id: "ot_xxx",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  });

  assert.deepEqual(message, {
    session: {
      agentId: "planner",
      channelId: "feishu",
      sessionId: "ot_xxx",
      metadata: {
        feishuReplyMessageId: "om_xxx",
        feishuChatId: "oc_xxx",
        feishuThreadId: "ot_xxx",
      },
    },
    content: "hello",
  });
});

test("rememberMessageId deduplicates repeated Feishu message ids and expires old entries", () => {
  const seen = new Map<string, number>();

  assert.equal(rememberMessageId(seen, "om_1", 1000, 100, 10), true);
  assert.equal(rememberMessageId(seen, "om_1", 1001, 100, 10), false);
  assert.equal(rememberMessageId(seen, "om_2", 1150, 100, 10), true);
  assert.equal(rememberMessageId(seen, "om_1", 1201, 100, 10), true);
});
