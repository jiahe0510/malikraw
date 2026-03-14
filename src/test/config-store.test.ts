import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfigBundle, loadRuntimeConfig, saveConfigBundle } from "../index.js";

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
          contextWindow: 16384,
          maxTokens: 2048,
          compact: {
            thresholdTokens: 9000,
            targetTokens: 4500,
            instructionPath: "/tmp/compact.md",
          },
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
      channels: {
        defaultChannelId: "http",
        channels: [{
          id: "http",
          type: "http",
          agentId: "primary",
        }, {
          id: "feishu",
          type: "feishu",
          appId: "cli_a",
          appSecret: "secret",
          agentId: "primary",
          replyMode: "chat",
        }],
      },
      tools: {
        braveSearchApiKey: "brave-key",
      },
      memory: {
        enabled: true,
        postgresUrl: "postgres://localhost:5432/malikraw",
        redisUrl: "redis://127.0.0.1:6379",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        sessionRecentMessages: 6,
        semanticTopK: 4,
        episodicTopK: 3,
        maxPromptChars: 1500,
        importanceThreshold: 0.7,
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
    assert.equal(config.model.contextWindow, 16384);
    assert.equal(config.model.maxTokens, 2048);
    assert.equal(config.model.compact.thresholdTokens, 9000);
    assert.equal(config.model.compact.targetTokens, 4500);
    assert.equal(config.model.compact.instructionPath, "/tmp/compact.md");
    assert.equal(config.workspaceRoot, path.join(malikrawHome, "workspace"));
    assert.deepEqual(config.activeSkillIds, ["workspace_operator", "reviewer"]);
    assert.equal(config.globalPolicy, "stored policy");
    assert.equal(config.stateSummary, "stored state");
    assert.equal(config.memorySummary, "stored memory");
    assert.equal(config.maxIterations, undefined);
    assert.equal(config.debugModelMessages, false);
    assert.equal(config.gatewayPort, 6060);
    assert.equal(config.memory?.enabled, true);
    assert.equal(config.memory?.postgresUrl, "postgres://localhost:5432/malikraw");
    assert.equal(config.memory?.redisUrl, "redis://127.0.0.1:6379");
    assert.equal(config.memory?.embeddingModel, "text-embedding-3-small");
    assert.equal(config.memory?.sessionRecentMessages, 6);
    assert.equal(config.defaultAgentId, "primary");
    assert.deepEqual(config.channels, [{
      id: "http",
      type: "http",
      agentId: "primary",
    }, {
      id: "feishu",
      type: "feishu",
      appId: "cli_a",
      appSecret: "secret",
      agentId: "primary",
      replyMode: "chat",
    }]);
    assert.equal(loadConfigBundle().tools?.braveSearchApiKey, "brave-key");
    assert.deepEqual(config.agents, [{
      id: "primary",
      model: {
        baseURL: "https://example.invalid/v1",
        apiKey: "stored-key",
        model: "stored-model",
        profile: "openai",
        temperature: 0.3,
        contextWindow: 16384,
        maxTokens: 2048,
        compact: {
          thresholdTokens: 9000,
          targetTokens: 4500,
          instructionPath: "/tmp/compact.md",
        },
      },
      activeSkillIds: ["workspace_operator", "reviewer"],
    }]);
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
      channels: {
        defaultChannelId: "http",
        channels: [{
          id: "http",
          type: "http",
          agentId: "primary",
        }],
      },
      tools: {},
      memory: {
        enabled: false,
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
    assert.equal(config.model.contextWindow, 32768);
    assert.equal(config.model.maxTokens, 4096);
    assert.equal(config.defaultAgentId, "primary");
    assert.deepEqual(config.channels, [{
      id: "http",
      type: "http",
      agentId: "primary",
    }]);
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

test("loadRuntimeConfig fails clearly when enhanced memory is enabled without postgres", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    saveConfigBundle({
      system: {
        gatewayPort: 6060,
        maxIterations: 8,
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
      channels: {
        defaultChannelId: "http",
        channels: [{
          id: "http",
          type: "http",
          agentId: "primary",
        }],
      },
      tools: {},
      memory: {
        enabled: true,
        redisUrl: "redis://127.0.0.1:6379",
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

    assert.throws(
      () => loadRuntimeConfig(),
      /Enhanced memory is enabled but memory\.postgresUrl is missing/,
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});

test("loadRuntimeConfig fails clearly when enhanced memory is enabled without redis", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    saveConfigBundle({
      system: {
        gatewayPort: 6060,
        maxIterations: 8,
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
      channels: {
        defaultChannelId: "http",
        channels: [{
          id: "http",
          type: "http",
          agentId: "primary",
        }],
      },
      tools: {},
      memory: {
        enabled: true,
        postgresUrl: "postgres://localhost:5432/malikraw",
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

    assert.throws(
      () => loadRuntimeConfig(),
      /Enhanced memory is enabled but memory\.redisUrl is missing/,
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
  }
});
