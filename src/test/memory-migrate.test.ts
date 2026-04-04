import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRuntimeConfig, saveConfigBundle } from "../index.js";

test("loadRuntimeConfig keeps memory config without embedding options", async () => {
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
      memory: {},
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
    assert.deepEqual(config.memory, {});
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});
