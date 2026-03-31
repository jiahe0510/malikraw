import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 40_000;

export const readUrlTool = defineTool({
  name: "read_url",
  description: "Fetch a URL and return cleaned textual content for webpages, markdown, txt, json, and similar text documents.",
  inputSchema: s.object(
    {
      url: s.string({ minLength: 1, maxLength: 2000 }),
    },
    { required: ["url"] },
  ),
  execute: async ({ url }, context) => {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new Error(`Unsupported URL protocol: ${target.protocol}`);
    }
    if (isFeishuDocUrl(target)) {
      throw new Error("This looks like a Feishu doc or wiki URL. Use read_feishu_doc instead.");
    }

    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: context.signal,
      headers: {
        Accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`URL request failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new Error(`URL response too large (${body.length} bytes)`);
    }

    const content = normalizeUrlContent(body, contentType);

    return {
      url: response.url || target.toString(),
      contentType: contentType || undefined,
      content,
      truncated: content.length >= MAX_TEXT_CHARS,
    };
  },
}) satisfies ToolSpec;

export function normalizeUrlContent(body: string, contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (
    normalized.includes("text/plain")
    || normalized.includes("text/markdown")
    || normalized.includes("application/json")
    || normalized.includes("application/xml")
    || normalized.includes("text/xml")
  ) {
    return truncate(body.trim(), MAX_TEXT_CHARS);
  }

  return truncate(extractTextFromHtml(body), MAX_TEXT_CHARS);
}

export function extractTextFromHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim(),
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function isFeishuDocUrl(target: URL): boolean {
  const hostname = target.hostname.toLowerCase();
  if (!hostname.includes("feishu.cn") && !hostname.includes("larksuite.com")) {
    return false;
  }

  return /\/(docx|wiki)\//.test(target.pathname);
}
