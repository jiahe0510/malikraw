import test from "node:test";
import assert from "node:assert/strict";

import { OpenAICompatibleModel, type AgentMessage } from "../index.js";

test("OpenAICompatibleModel strips <think> blocks from final output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: "<think>internal reasoning</think>\n\nhello",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const model = new OpenAICompatibleModel({
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 8192,
      compact: {
        thresholdTokens: 4096,
        targetTokens: 2048,
      },
    });

    const result = await model.generate({
      messages: [{ role: "user", content: "hi" } satisfies AgentMessage],
      tools: [],
    });

    assert.deepEqual(result, {
      type: "final",
      outputText: "hello",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleModel strips leaked planning preambles from final output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: "We need to understand the situation and plan response.\n\nWe have a fairly extensive system context.\n\n你好，我在。",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const model = new OpenAICompatibleModel({
      baseURL: "https://example.invalid/v1",
      apiKey: "dummy",
      model: "test-model",
      contextWindow: 8192,
      compact: {
        thresholdTokens: 4096,
        targetTokens: 2048,
      },
    });

    const result = await model.generate({
      messages: [{ role: "user", content: "hi" } satisfies AgentMessage],
      tools: [],
    });

    assert.deepEqual(result, {
      type: "final",
      outputText: "你好，我在。",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
