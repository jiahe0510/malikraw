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

test("profile normalization emits cache_control only when explicitly enabled", () => {
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: "stable",
      contentBlocks: [{ type: "text", text: "stable" }],
      cacheControl: { type: "ephemeral" },
    },
  ];

  assert.deepEqual(normalizeMessagesForProfile(messages, "openai"), [
    { role: "system", content: "stable" },
  ]);

  assert.deepEqual(normalizeMessagesForProfile(messages, "openai", { explicitCacheControl: true }), [
    {
      role: "system",
      content: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
    },
  ]);
});

test("profile normalization places explicit cache_control at the stable prefix boundary", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "policy", cacheControl: { type: "ephemeral" } },
    { role: "developer", content: "skills", cacheControl: { type: "ephemeral" } },
    { role: "developer", content: "dynamic" },
    { role: "user", content: "hi" },
  ];

  assert.deepEqual(normalizeMessagesForProfile(messages, "openai", { explicitCacheControl: true }), [
    { role: "system", content: "policy" },
    {
      role: "developer",
      content: [{ type: "text", text: "skills", cache_control: { type: "ephemeral" } }],
    },
    { role: "developer", content: "dynamic" },
    { role: "user", content: "hi" },
  ]);
});
