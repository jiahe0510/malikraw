import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ToolRegistry, registerBuiltinTools, saveConfigBundle } from "../index.js";
import { buildBraveWebSearchUrl, normalizeBraveResults } from "../tools/web-search.js";

test("buildBraveWebSearchUrl maps tool input to Brave query params", () => {
  const url = new URL(buildBraveWebSearchUrl({
    query: "openai api",
    resultType: "web",
    count: 3,
    offset: 2,
    country: "us",
    searchLang: "en",
    uiLang: "en-US",
    freshness: "pd",
    safeSearch: "moderate",
    extraSnippets: true,
    goggles: ["https://example.com/g1", "https://example.com/g2"],
  }));

  assert.equal(url.origin, "https://api.search.brave.com");
  assert.equal(url.pathname, "/res/v1/web/search");
  assert.equal(url.searchParams.get("q"), "openai api");
  assert.equal(url.searchParams.get("count"), "3");
  assert.equal(url.searchParams.get("offset"), "2");
  assert.equal(url.searchParams.get("country"), "US");
  assert.equal(url.searchParams.get("search_lang"), "en");
  assert.equal(url.searchParams.get("ui_lang"), "en-US");
  assert.equal(url.searchParams.get("freshness"), "pd");
  assert.equal(url.searchParams.get("safesearch"), "moderate");
  assert.equal(url.searchParams.get("extra_snippets"), "true");
  assert.deepEqual(url.searchParams.getAll("goggles"), ["https://example.com/g1", "https://example.com/g2"]);
});

test("buildBraveWebSearchUrl switches to news endpoint and respects news count limit", () => {
  const url = new URL(buildBraveWebSearchUrl({
    query: "world news",
    resultType: "news",
    count: 99,
  }));

  assert.equal(url.pathname, "/res/v1/news/search");
  assert.equal(url.searchParams.get("count"), "50");
});

test("normalizeBraveResults keeps compact result fields only", () => {
  const results = normalizeBraveResults({
    web: {
      results: [{
        title: "OpenAI",
        url: "https://openai.com",
        description: "AI research and products",
        age: "2026-03-07T00:00:00Z",
        language: "en",
        extra_snippets: ["snippet one", "snippet two"],
        family_friendly: true,
      }, {
        description: "missing title and url",
      }],
    },
  });

  assert.deepEqual(results, [{
    title: "OpenAI",
    url: "https://openai.com",
    description: "AI research and products",
    age: "2026-03-07T00:00:00Z",
    language: "en",
    extraSnippets: ["snippet one", "snippet two"],
  }]);
});

test("normalizeBraveResults supports news payload shape", () => {
  const results = normalizeBraveResults({
    query: {
      original: "world news",
    },
    results: [{
      title: "World",
      url: "https://example.com/world",
      description: "headline",
      age: "1 day ago",
    }],
  });

  assert.deepEqual(results, [{
    title: "World",
    url: "https://example.com/world",
    description: "headline",
    age: "1 day ago",
    language: undefined,
  }]);
});

test("web_search calls Brave API and returns compact results", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  const previousApiKey = process.env.BRAVE_SEARCH_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.MALIKRAW_HOME = malikrawHome;
  delete process.env.BRAVE_SEARCH_API_KEY;

  saveConfigBundle({
    system: {
      gatewayPort: 5050,
      maxIterations: 8,
      debugModelMessages: false,
    },
    providers: {
      defaultProviderId: "default",
      providers: [{
        id: "default",
        baseURL: "https://example.invalid/v1",
        apiKey: "dummy",
        model: "dummy-model",
      }],
    },
    agentProviderMapping: {
      defaultProviderId: "default",
      mappings: {},
    },
    workspace: {
      workspaceRoot: malikrawHome,
    },
    channels: {
      defaultChannelId: "",
      channels: [],
    },
    tools: {
      braveSearchApiKey: "test-key",
    },
    memory: {},
    agents: {
      defaultAgentId: "primary",
      agents: [{ id: "primary", activeSkillIds: ["workspace_operator"] }],
    },
  });

  globalThis.fetch = async (input, init) => {
    const url = toUrl(input);
    assert.equal(url.pathname, "/res/v1/web/search");
    assert.equal(url.searchParams.get("q"), "brave search");
    assert.equal(url.searchParams.get("count"), "2");
    assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "test-key");

    return new Response(JSON.stringify({
      query: {
        original: "brave search",
        more_results_available: true,
      },
      web: {
        results: [{
          title: "Brave Search API",
          url: "https://brave.com/search/api/",
          description: "Official docs",
        }, {
          title: "Brave",
          url: "https://brave.com",
          description: "Homepage",
        }],
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const registry = registerBuiltinTools(new ToolRegistry());
    const result = await registry.execute("web_search", {
      query: "brave search",
      count: 2,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    const data = result.data as {
      query: string;
      resultType: string;
      resolvedQuery: string;
      moreResultsAvailable: boolean;
      count: number;
      results: Array<{ title: string; url: string }>;
    };
    assert.equal(data.query, "brave search");
    assert.equal(data.resultType, "web");
    assert.equal(data.resolvedQuery, "brave search");
    assert.equal(data.moreResultsAvailable, true);
    assert.equal(data.count, 2);
    assert.equal(data.results[0]?.title, "Brave Search API");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
    if (previousApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousApiKey;
    }
  }
});

test("web_search can call Brave news endpoint", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  const previousApiKey = process.env.BRAVE_SEARCH_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.MALIKRAW_HOME = malikrawHome;
  delete process.env.BRAVE_SEARCH_API_KEY;

  saveConfigBundle({
    system: {
      gatewayPort: 5050,
      maxIterations: 8,
      debugModelMessages: false,
    },
    providers: {
      defaultProviderId: "default",
      providers: [{
        id: "default",
        baseURL: "https://example.invalid/v1",
        apiKey: "dummy",
        model: "dummy-model",
      }],
    },
    agentProviderMapping: {
      defaultProviderId: "default",
      mappings: {},
    },
    workspace: {
      workspaceRoot: malikrawHome,
    },
    channels: {
      defaultChannelId: "",
      channels: [],
    },
    tools: {
      braveSearchApiKey: "test-key",
    },
    memory: {},
    agents: {
      defaultAgentId: "primary",
      agents: [{ id: "primary", activeSkillIds: ["workspace_operator"] }],
    },
  });

  globalThis.fetch = async (input, init) => {
    const url = toUrl(input);
    assert.equal(url.pathname, "/res/v1/news/search");
    assert.equal(url.searchParams.get("q"), "world news");
    assert.equal(url.searchParams.get("extra_snippets"), "true");
    assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Subscription-Token"], "test-key");

    return new Response(JSON.stringify({
      query: {
        original: "world news",
        more_results_available: false,
      },
      results: [{
        title: "Top headline",
        url: "https://example.com/news",
        description: "breaking",
        age: "2 hours ago",
        extra_snippets: ["more context"],
      }],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const registry = registerBuiltinTools(new ToolRegistry());
    const result = await registry.execute("web_search", {
      query: "world news",
      resultType: "news",
      extraSnippets: true,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    const data = result.data as {
      resultType: string;
      moreResultsAvailable: boolean;
      results: Array<{ title: string; extraSnippets?: string[] }>;
    };
    assert.equal(data.resultType, "news");
    assert.equal(data.moreResultsAvailable, false);
    assert.equal(data.results[0]?.title, "Top headline");
    assert.deepEqual(data.results[0]?.extraSnippets, ["more context"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
    if (previousApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousApiKey;
    }
  }
});

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }

  return new URL(input.url);
}

test("web_search fails clearly when BRAVE_SEARCH_API_KEY is missing", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  const previousApiKey = process.env.BRAVE_SEARCH_API_KEY;
  process.env.MALIKRAW_HOME = malikrawHome;
  delete process.env.BRAVE_SEARCH_API_KEY;

  try {
    const registry = registerBuiltinTools(new ToolRegistry());
    const result = await registry.execute("web_search", {
      query: "brave search",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /Brave Search API key/);
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.MALIKRAW_HOME;
    } else {
      process.env.MALIKRAW_HOME = previousHome;
    }
    if (previousApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousApiKey;
    }
  }
});
