import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createTextMessage,
  getRuntimeEventFilePath,
  ModelRequestError,
  OpenAICompatibleModel,
  type AgentMessage,
} from "../index.js";

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

test("OpenAICompatibleModel sends block-aware content parts in request bodies", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "ok",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

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

    await model.generate({
      messages: [{
        ...createTextMessage("user", "line 1"),
        contentBlocks: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      } satisfies AgentMessage],
      tools: [],
    });

    assert.deepEqual(requestBody?.messages, [{
      role: "user",
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    }]);
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

test("OpenAICompatibleModel marks context-length failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("maximum context length exceeded", {
      status: 400,
      headers: { "content-type": "text/plain" },
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

    await assert.rejects(
      () => model.generate({
        messages: [{ role: "user", content: "hi" } satisfies AgentMessage],
        tools: [],
      }),
      (error: unknown) => {
        assert.equal(error instanceof ModelRequestError, true);
        assert.equal((error as ModelRequestError).contextLengthExceeded, true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleModel writes llm request events", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-llm-events-"));
  const previousHome = process.env.MALIKRAW_HOME;
  const originalFetch = globalThis.fetch;
  process.env.MALIKRAW_HOME = malikrawHome;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{
        message: {
          content: "ok",
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

    await model.generate({
      messages: [{ role: "user", content: "hi" } satisfies AgentMessage],
      tools: [],
    });

    const eventNames = (await readFile(getRuntimeEventFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).name);
    assert.ok(eventNames.includes("llm.request.start"));
    assert.ok(eventNames.includes("llm.request.success"));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});
