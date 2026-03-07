import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRuntimeConfig, saveConfigBundle } from "../index.js";

test("loadRuntimeConfig reads persisted malikraw config files", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    saveConfigBundle({
      system: {
        gatewayPort: 6060,
        maxIterations: 12,
        debugModelMessages: true,
        globalPolicy: "stored policy",
        stateSummary: "stored state",
        memorySummary: "stored memory",
      },
      providers: {
        defaultProviderId: "default",
        providers: [{
          id: "default",
          baseURL: "https://example.invalid/v1",
          apiKey: "stored-key",
          model: "stored-model",
          profile: "openai",
          temperature: 0.3,
          maxTokens: 2048,
        }],
      },
      agentProviderMapping: {
        defaultProviderId: "default",
        mappings: {
          primary: "default",
        },
      },
      workspace: {
        workspaceRoot: path.join(malikrawHome, "workspace"),
      },
      agents: {
        defaultAgentId: "primary",
        agents: [{
          id: "primary",
          activeSkillIds: ["workspace_operator", "reviewer"],
          providerId: "default",
        }],
      },
    });

    const config = loadRuntimeConfig();

    assert.equal(config.model.baseURL, "https://example.invalid/v1");
    assert.equal(config.model.apiKey, "stored-key");
    assert.equal(config.model.model, "stored-model");
    assert.equal(config.model.temperature, 0.3);
    assert.equal(config.model.maxTokens, 2048);
    assert.equal(config.workspaceRoot, path.join(malikrawHome, "workspace"));
    assert.deepEqual(config.activeSkillIds, ["workspace_operator", "reviewer"]);
    assert.equal(config.globalPolicy, "stored policy");
    assert.equal(config.stateSummary, "stored state");
    assert.equal(config.memorySummary, "stored memory");
    assert.equal(config.maxIterations, 12);
    assert.equal(config.debugModelMessages, true);
    assert.equal(config.gatewayPort, 6060);
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});

test("loadRuntimeConfig ignores OPENAI environment variables and uses stored config only", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousModel = process.env.OPENAI_MODEL;
  process.env.MALIKRAW_HOME = malikrawHome;
  process.env.OPENAI_BASE_URL = "https://should-not-be-used.invalid";
  process.env.OPENAI_MODEL = "wrong-model";

  try {
    saveConfigBundle({
      system: {
        gatewayPort: 6060,
        maxIterations: 12,
        debugModelMessages: false,
      },
      providers: {
        defaultProviderId: "default",
        providers: [{
          id: "default",
          baseURL: "https://stored.example/v1",
          apiKey: "stored-key",
          model: "stored-model",
          profile: "openai",
        }],
      },
      agentProviderMapping: {
        defaultProviderId: "default",
        mappings: {
          primary: "default",
        },
      },
      workspace: {
        workspaceRoot: path.join(malikrawHome, "workspace"),
      },
      agents: {
        defaultAgentId: "primary",
        agents: [{
          id: "primary",
          activeSkillIds: ["workspace_operator"],
          providerId: "default",
        }],
      },
    });

    const config = loadRuntimeConfig();

    assert.equal(config.model.baseURL, "https://stored.example/v1");
    assert.equal(config.model.model, "stored-model");
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }

    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }

    if (previousModel === undefined) {
      delete process.env.OPENAI_MODEL;
    } else {
      process.env.OPENAI_MODEL = previousModel;
    }
  }
});
