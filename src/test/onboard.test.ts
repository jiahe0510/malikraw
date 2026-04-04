import test from "node:test";
import assert from "node:assert/strict";

import {
  formatChannelsSummary,
  formatProviderSummary,
  formatToolsSummary,
  maskSecret,
  resolveDefaultChannelId,
} from "../cli/onboard.js";

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

test("maskSecret hides the middle of stored keys", () => {
  assert.equal(maskSecret("sk-1234567890"), "sk-***890");
  assert.equal(maskSecret("abcdef"), "a***f");
  assert.equal(maskSecret(""), "(empty)");
});

test("formatProviderSummary shows existing provider details with a masked key", () => {
  const summary = formatProviderSummary({
    id: "default",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-1234567890",
    model: "gpt-4.1-mini",
    profile: "openai",
    contextWindow: 32768,
    maxTokens: 4096,
  });

  assert.match(summary, /openai \| gpt-4\.1-mini \| api\.openai\.com\/v1 \| key=sk-\*\*\*890/);
});

test("formatChannelsSummary shows configured channels", () => {
  const summary = formatChannelsSummary([
    { id: "http", type: "http", agentId: "main" },
    { id: "feishu", type: "feishu", agentId: "main", appId: "app", appSecret: "secret" },
  ]);

  assert.equal(summary, "http:http agent=main, feishu:feishu agent=main");
});

test("formatToolsSummary shows enabled tools with masked keys", () => {
  const summary = formatToolsSummary({
    braveSearchApiKey: "brv-1234567890",
  });

  assert.equal(summary, "web_search key=brv***890");
});
