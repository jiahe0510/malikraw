const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}\[\]()#+\-!|>~])/g;

export type FeishuPostParseResult = {
  textContent: string;
  imageKeys: string[];
  mediaKeys: Array<{ fileKey: string; fileName?: string }>;
  mentionedOpenIds: string[];
};

export type FeishuMention = {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name: string;
  tenant_key?: string;
};

type PostPayload = {
  title: string;
  content: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeExternalKey(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : undefined;
}

function escapeMarkdownText(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARS, "\\$1");
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function isStyleEnabled(style: Record<string, unknown> | undefined, key: string): boolean {
  if (!style) {
    return false;
  }
  return toBoolean(style[key]);
}

function wrapInlineCode(text: string): string {
  const maxRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(maxRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${fence}${body}${fence}`;
}

function sanitizeFenceLanguage(language: string): string {
  return language.trim().replace(/[^A-Za-z0-9_+#.-]/g, "");
}

function renderTextElement(element: Record<string, unknown>): string {
  const text = toStringOrEmpty(element.text);
  const style = isRecord(element.style) ? element.style : undefined;

  if (isStyleEnabled(style, "code")) {
    return wrapInlineCode(text);
  }

  let rendered = escapeMarkdownText(text);
  if (!rendered) {
    return "";
  }

  if (isStyleEnabled(style, "bold")) {
    rendered = `**${rendered}**`;
  }
  if (isStyleEnabled(style, "italic")) {
    rendered = `*${rendered}*`;
  }
  if (isStyleEnabled(style, "underline")) {
    rendered = `<u>${rendered}</u>`;
  }
  if (
    isStyleEnabled(style, "strikethrough") ||
    isStyleEnabled(style, "line_through") ||
    isStyleEnabled(style, "lineThrough")
  ) {
    rendered = `~~${rendered}~~`;
  }

  return rendered;
}

function renderLinkElement(element: Record<string, unknown>): string {
  const href = toStringOrEmpty(element.href).trim();
  const rawText = toStringOrEmpty(element.text);
  const text = rawText || href;
  if (!text) {
    return "";
  }
  if (!href) {
    return escapeMarkdownText(text);
  }
  return `[${escapeMarkdownText(text)}](${href})`;
}

function renderCodeBlockElement(element: Record<string, unknown>): string {
  const language = sanitizeFenceLanguage(
    toStringOrEmpty(element.language) || toStringOrEmpty(element.lang),
  );
  const code = (toStringOrEmpty(element.text) || toStringOrEmpty(element.content)).replace(
    /\r\n/g,
    "\n",
  );
  const trailingNewline = code.endsWith("\n") ? "" : "\n";
  return `\`\`\`${language}\n${code}${trailingNewline}\`\`\``;
}

function renderElement(
  element: unknown,
  imageKeys: string[],
  mediaKeys: Array<{ fileKey: string; fileName?: string }>,
  mentionedOpenIds: string[],
): string {
  if (!isRecord(element)) {
    return escapeMarkdownText(toStringOrEmpty(element));
  }

  const tag = toStringOrEmpty(element.tag).toLowerCase();
  switch (tag) {
    case "text":
      return renderTextElement(element);
    case "a":
      return renderLinkElement(element);
    case "at":
      {
        const mentionId = normalizeExternalKey(element.open_id) ?? normalizeExternalKey(element.user_id);
        if (mentionId) {
          mentionedOpenIds.push(mentionId);
        }
      }
      return `@${escapeMarkdownText(toStringOrEmpty(element.user_name) || toStringOrEmpty(element.open_id))}`;
    case "img": {
      const imageKey = normalizeExternalKey(element.image_key);
      if (imageKey) {
        imageKeys.push(imageKey);
      }
      return "![image]";
    }
    case "media": {
      const fileKey = normalizeExternalKey(element.file_key);
      if (fileKey) {
        mediaKeys.push({
          fileKey,
          fileName: toStringOrEmpty(element.file_name) || undefined,
        });
      }
      return "[media]";
    }
    case "emotion":
      return escapeMarkdownText(
        toStringOrEmpty(element.emoji) ||
        toStringOrEmpty(element.text) ||
        toStringOrEmpty(element.emoji_type),
      );
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "code": {
      const code = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
      return code ? wrapInlineCode(code) : "";
    }
    case "code_block":
    case "pre":
      return renderCodeBlockElement(element);
    default:
      return escapeMarkdownText(toStringOrEmpty(element.text));
  }
}

function toPostPayload(candidate: unknown): PostPayload | null {
  if (!isRecord(candidate) || !Array.isArray(candidate.content)) {
    return null;
  }

  return {
    title: toStringOrEmpty(candidate.title),
    content: candidate.content,
  };
}

function resolveLocalePayload(candidate: unknown): PostPayload | null {
  const direct = toPostPayload(candidate);
  if (direct) {
    return direct;
  }
  if (!isRecord(candidate)) {
    return null;
  }
  for (const value of Object.values(candidate)) {
    const localePayload = toPostPayload(value);
    if (localePayload) {
      return localePayload;
    }
  }
  return null;
}

function resolvePostPayload(parsed: unknown): PostPayload | null {
  const direct = toPostPayload(parsed);
  if (direct) {
    return direct;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const wrappedPost = resolveLocalePayload(parsed.post);
  if (wrappedPost) {
    return wrappedPost;
  }

  return resolveLocalePayload(parsed);
}

export function parsePostContent(content: string): FeishuPostParseResult {
  try {
    const parsed = JSON.parse(content);
    const payload = resolvePostPayload(parsed);
    if (!payload) {
      return {
        textContent: FALLBACK_POST_TEXT,
        imageKeys: [],
        mediaKeys: [],
        mentionedOpenIds: [],
      };
    }

    const imageKeys: string[] = [];
    const mediaKeys: Array<{ fileKey: string; fileName?: string }> = [];
    const mentionedOpenIds: string[] = [];
    const paragraphs: string[] = [];

    for (const paragraph of payload.content) {
      if (!Array.isArray(paragraph)) {
        continue;
      }
      let renderedParagraph = "";
      for (const element of paragraph) {
        renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);
      }
      paragraphs.push(renderedParagraph);
    }

    const title = escapeMarkdownText(payload.title.trim());
    const body = paragraphs.join("\n").trim();
    const textContent = [title, body].filter(Boolean).join("\n\n").trim();

    return {
      textContent: textContent || FALLBACK_POST_TEXT,
      imageKeys,
      mediaKeys,
      mentionedOpenIds,
    };
  } catch {
    return {
      textContent: FALLBACK_POST_TEXT,
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
    };
  }
}

export function extractFeishuMessageText(messageType: string, content: string): string | undefined {
  try {
    if (messageType === "text") {
      const parsed = JSON.parse(content) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text.trim() : undefined;
    }
    if (messageType === "post") {
      return parsePostContent(content).textContent.trim();
    }
    if (messageType === "share_chat") {
      const parsed = JSON.parse(content) as {
        body?: unknown;
        summary?: unknown;
        share_chat_id?: unknown;
      };
      if (typeof parsed.body === "string" && parsed.body.trim()) {
        return parsed.body.trim();
      }
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        return parsed.summary.trim();
      }
      if (typeof parsed.share_chat_id === "string" && parsed.share_chat_id.trim()) {
        return `[Forwarded message: ${parsed.share_chat_id.trim()}]`;
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      return "[Merged and Forwarded Message - loading...]";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function parseFeishuMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content) as {
      image_key?: unknown;
      file_key?: unknown;
      file_name?: unknown;
    };
    const imageKey = normalizeExternalKey(parsed.image_key);
    const fileKey = normalizeExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey, fileName: typeof parsed.file_name === "string" ? parsed.file_name : undefined };
      case "file":
      case "audio":
      case "sticker":
        return { fileKey, fileName: typeof parsed.file_name === "string" ? parsed.file_name : undefined };
      case "video":
      case "media":
        return {
          imageKey,
          fileKey,
          fileName: typeof parsed.file_name === "string" ? parsed.file_name : undefined,
        };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

export function toFeishuMessageResourceType(messageType: string): "image" | "file" {
  return messageType === "image" ? "image" : "file";
}

export function inferFeishuInboundPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "[Feishu image]";
    case "file":
      return "[Feishu file]";
    case "audio":
      return "[Feishu audio]";
    case "video":
    case "media":
      return "[Feishu video]";
    case "sticker":
      return "[Feishu sticker]";
    default:
      return "[Feishu attachment]";
  }
}

export function normalizeFeishuMentions(
  text: string,
  mentions?: FeishuMention[],
  botStripId?: string,
): string {
  if (!mentions?.length) {
    return text.trim();
  }

  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let result = text;

  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const replacement =
      botStripId && mentionId === botStripId
        ? ""
        : mentionId
          ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
          : `@${mention.name}`;
    result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement);
  }

  return result.replace(/\s+/g, " ").trim();
}

export function stripLeadingFeishuBotMention(
  text: string,
  botMentionNames: string[],
): string {
  let result = text.trim();
  if (!result) {
    return result;
  }

  for (const name of botMentionNames) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(`^@${escapedName}(?=\\s|$|[,:，：])`, "iu"), "")
      .trim();
  }

  return result.replace(/^[,:，：\s]+/, "").trim();
}
