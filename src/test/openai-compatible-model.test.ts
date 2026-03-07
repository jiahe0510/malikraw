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
