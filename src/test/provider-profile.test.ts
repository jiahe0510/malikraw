import test from "node:test";
import assert from "node:assert/strict";

import { createJsonMessage, normalizeMessagesForProfile, type AgentMessage } from "../index.js";

test("openai profile keeps developer messages separate", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "global policy" },
    { role: "developer", content: "skill block" },
    { role: "user", content: "help me" },
  ];

  const normalized = normalizeMessagesForProfile(messages, "openai");

  assert.deepEqual(normalized, [
    { role: "system", content: "global policy" },
    { role: "developer", content: "skill block" },
    { role: "user", content: "help me" },
  ]);
});

test("qwen profile merges instruction messages into one system message", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "global policy" },
    { role: "developer", content: "skill block" },
    { role: "user", content: "<system-reminder>\n# Current Date\n2026-04-04\n</system-reminder>" },
    { role: "user", content: "help me" },
  ];

  const normalized = normalizeMessagesForProfile(messages, "qwen");

  assert.deepEqual(normalized, [
    {
      role: "system",
      content: [
        { type: "text", text: "global policy" },
        { type: "text", text: "skill block" },
      ],
    },
    { role: "user", content: "<system-reminder>\n# Current Date\n2026-04-04\n</system-reminder>" },
    { role: "user", content: "help me" },
  ]);
});

test("openai profile preserves block content as transport content parts", () => {
  const normalized = normalizeMessagesForProfile([
    createJsonMessage("tool", { ok: true, path: "README.md" }, {
      toolCallId: "call_1",
      toolName: "read_file",
    }),
  ], "openai");

  assert.deepEqual(normalized, [{
    role: "tool",
    content: "{\"ok\":true,\"path\":\"README.md\"}",
    tool_call_id: "call_1",
    name: "read_file",
  }]);
});
