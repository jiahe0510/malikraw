import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { loadConfigBundle } from "../core/config/config-store.js";

const BRAVE_WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type BraveWebSearchApiResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      language?: string;
      family_friendly?: boolean;
    }>;
  };
  query?: {
    original?: string;
  };
  mixed?: {
    main?: Array<{
      type?: string;
      index?: number;
    }>;
  };
};

export const webSearchTool = defineTool({
  name: "web_search",
  description: "Search the web with Brave Search API and return a compact list of results.",
  inputSchema: s.object(
    {
      query: s.string({ minLength: 1, maxLength: 400 }),
      count: s.optional(s.number({ integer: true, min: 1, max: 20 })),
      offset: s.optional(s.number({ integer: true, min: 0, max: 9 })),
      country: s.optional(s.string({ minLength: 2, maxLength: 2 })),
      searchLang: s.optional(s.string({ minLength: 2, maxLength: 10 })),
      freshness: s.optional(s.string({ minLength: 1, maxLength: 32 })),
    },
    { required: ["query"] },
  ),
  execute: async ({ query, count, offset, country, searchLang, freshness }, context) => {
    const apiKey = requireBraveSearchApiKey();
    const requestUrl = buildBraveWebSearchUrl({
      query,
      count,
      offset,
      country,
      searchLang,
      freshness,
    });

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: context.signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `Brave Search API request failed with status ${response.status}: ${truncate(responseText, 300)}`,
      );
    }

    const payload = await response.json() as BraveWebSearchApiResponse;
    const results = normalizeBraveResults(payload);

    return {
      query,
      resolvedQuery: payload.query?.original ?? query,
      count: results.length,
      results,
    };
  },
}) satisfies ToolSpec;

export function buildBraveWebSearchUrl(input: {
  query: string;
  count?: number;
  offset?: number;
  country?: string;
  searchLang?: string;
  freshness?: string;
}): string {
  const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", String(input.count ?? 5));
  url.searchParams.set("offset", String(input.offset ?? 0));

  if (input.country) {
    url.searchParams.set("country", input.country.toUpperCase());
  }
  if (input.searchLang) {
    url.searchParams.set("search_lang", input.searchLang);
  }
  if (input.freshness) {
    url.searchParams.set("freshness", input.freshness);
  }

  return url.toString();
}

export function normalizeBraveResults(payload: BraveWebSearchApiResponse): Array<{
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
}> {
  return (payload.web?.results ?? [])
    .filter((result) => typeof result.title === "string" && typeof result.url === "string")
    .map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      description: result.description ?? "",
      age: result.age,
      language: result.language,
    }));
}

function requireBraveSearchApiKey(): string {
  const apiKey = loadConfigBundle().tools?.braveSearchApiKey?.trim()
    || process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Missing Brave Search API key. Configure it in `malikraw onboard` or set BRAVE_SEARCH_API_KEY.",
    );
  }

  return apiKey;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
