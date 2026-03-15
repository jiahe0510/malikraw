import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { loadConfigBundle } from "../core/config/config-store.js";

const BRAVE_WEB_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_NEWS_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/news/search";

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  language?: string;
  extra_snippets?: string[];
  family_friendly?: boolean;
};

type BraveSearchApiResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
  results?: BraveSearchResult[];
  query?: {
    original?: string;
    more_results_available?: boolean;
  };
};

export const webSearchTool = defineTool({
  name: "web_search",
  description: "Search Brave web or news indexes and return a compact list of results.",
  inputSchema: s.object(
    {
      query: s.string({ minLength: 1, maxLength: 400 }),
      resultType: s.optional(s.union([s.literal("web"), s.literal("news")])),
      count: s.optional(s.number({ integer: true, min: 1, max: 50 })),
      offset: s.optional(s.number({ integer: true, min: 0, max: 9 })),
      country: s.optional(s.string({ minLength: 2, maxLength: 2 })),
      searchLang: s.optional(s.string({ minLength: 2, maxLength: 10 })),
      uiLang: s.optional(s.string({ minLength: 2, maxLength: 10 })),
      freshness: s.optional(s.string({ minLength: 1, maxLength: 32 })),
      safeSearch: s.optional(s.union([s.literal("off"), s.literal("moderate"), s.literal("strict")])),
      extraSnippets: s.optional(s.literal(true)),
      goggles: s.optional(s.union([
        s.string({ minLength: 1, maxLength: 400 }),
        s.array(s.string({ minLength: 1, maxLength: 400 }), { minItems: 1, maxItems: 10 }),
      ])),
    },
    { required: ["query"] },
  ),
  execute: async ({
    query,
    resultType,
    count,
    offset,
    country,
    searchLang,
    uiLang,
    freshness,
    safeSearch,
    extraSnippets,
    goggles,
  }, context) => {
    const apiKey = requireBraveSearchApiKey();
    const requestUrl = buildBraveWebSearchUrl({
      query,
      resultType,
      count,
      offset,
      country,
      searchLang,
      uiLang,
      freshness,
      safeSearch,
      extraSnippets,
      goggles,
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

    const payload = await response.json() as BraveSearchApiResponse;
    const results = normalizeBraveResults(payload);

    return {
      query,
      resultType: resultType ?? "web",
      resolvedQuery: payload.query?.original ?? query,
      moreResultsAvailable: payload.query?.more_results_available ?? false,
      count: results.length,
      results,
    };
  },
}) satisfies ToolSpec;

export function buildBraveWebSearchUrl(input: {
  query: string;
  resultType?: "web" | "news";
  count?: number;
  offset?: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
  safeSearch?: "off" | "moderate" | "strict";
  extraSnippets?: true;
  goggles?: string | string[];
}): string {
  const resultType = input.resultType ?? "web";
  const maxCount = resultType === "news" ? 50 : 20;
  const resolvedCount = Math.min(input.count ?? 5, maxCount);
  const url = new URL(resultType === "news" ? BRAVE_NEWS_SEARCH_ENDPOINT : BRAVE_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", String(resolvedCount));
  url.searchParams.set("offset", String(input.offset ?? 0));

  if (input.country) {
    url.searchParams.set("country", input.country.toUpperCase());
  }
  if (input.searchLang) {
    url.searchParams.set("search_lang", input.searchLang);
  }
  if (input.uiLang) {
    url.searchParams.set("ui_lang", input.uiLang);
  }
  if (input.freshness) {
    url.searchParams.set("freshness", input.freshness);
  }
  if (input.safeSearch) {
    url.searchParams.set("safesearch", input.safeSearch);
  }
  if (input.extraSnippets) {
    url.searchParams.set("extra_snippets", "true");
  }
  const goggles = Array.isArray(input.goggles) ? input.goggles : input.goggles ? [input.goggles] : [];
  for (const goggle of goggles) {
    url.searchParams.append("goggles", goggle);
  }

  return url.toString();
}

export function normalizeBraveResults(payload: BraveSearchApiResponse): Array<{
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
  extraSnippets?: string[];
}> {
  return (payload.web?.results ?? payload.results ?? [])
    .filter((result) => typeof result.title === "string" && typeof result.url === "string")
    .map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      description: result.description ?? "",
      age: result.age,
      language: result.language,
      ...(Array.isArray(result.extra_snippets) && result.extra_snippets.length > 0
        ? { extraSnippets: result.extra_snippets.filter((item): item is string => typeof item === "string") }
        : {}),
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
