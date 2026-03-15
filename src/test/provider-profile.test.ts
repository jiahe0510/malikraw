import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMessagesForProfile, type AgentMessage } from "../index.js";

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

test("qwen profile downgrades developer messages to standalone system messages", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "global policy" },
    { role: "developer", content: "skill block" },
    { role: "user", content: "help me" },
  ];

  const normalized = normalizeMessagesForProfile(messages, "qwen");

  assert.deepEqual(normalized, [
    { role: "system", content: "global policy" },
    { role: "system", content: "skill block" },
    { role: "user", content: "help me" },
  ]);
});
