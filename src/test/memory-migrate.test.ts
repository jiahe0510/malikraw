import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRuntimeConfig, saveConfigBundle } from "../index.js";

test("loadRuntimeConfig keeps configured embedding dimensions", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-memory-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    saveConfigBundle({
      system: {
        gatewayPort: 5050,
      },
      providers: {
        defaultProviderId: "default",
        providers: [{
          id: "default",
          baseURL: "https://example.invalid/v1",
          apiKey: "dummy",
          model: "test-model",
          profile: "openai",
        }],
      },
      agentProviderMapping: {
        defaultProviderId: "default",
        mappings: {
          main: "default",
        },
      },
      workspace: {
        workspaceRoot: path.join(malikrawHome, "workspace"),
      },
      channels: {
        defaultChannelId: "",
        channels: [],
      },
      tools: {},
      memory: {
        enabled: true,
        postgresUrl: "postgres://localhost:5432/malikraw",
        redisUrl: "redis://127.0.0.1:6379",
        embeddingModel: "text-embedding-nomic-embed-text-v1.5",
        embeddingDimensions: 768,
      },
      agents: {
        defaultAgentId: "main",
        agents: [{
          id: "main",
          activeSkillIds: [],
          providerId: "default",
        }],
      },
    });

    const config = loadRuntimeConfig();
    assert.equal(config.memory?.embeddingDimensions, 768);
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});
