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

test("qwen profile merges instruction messages into one system message", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "global policy" },
    { role: "developer", content: "skill block" },
    { role: "user", content: "<system-reminder>\n# Current Date\n2026-04-04\n</system-reminder>" },
    { role: "user", content: "help me" },
  ];

  const normalized = normalizeMessagesForProfile(messages, "qwen");

  assert.deepEqual(normalized, [
    { role: "system", content: "global policy\n\nskill block" },
    { role: "user", content: "<system-reminder>\n# Current Date\n2026-04-04\n</system-reminder>" },
    { role: "user", content: "help me" },
  ]);
});
