import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import type { ChannelDelivery, ChannelInboundMessage, ChannelMedia, ChannelStartContext, GatewayChannel } from "./channel.js";
import { getWorkspaceRoot, resolveWorkspacePath } from "../tools/_workspace.js";

const FEISHU_REPLY_MESSAGE_ID = "feishuReplyMessageId";
const FEISHU_CHAT_ID = "feishuChatId";
const FEISHU_THREAD_ID = "feishuThreadId";
const FEISHU_DEDUP_TTL_MS = 5 * 60 * 1000;
const FEISHU_DEDUP_MAX_SIZE = 2000;

type FeishuReceiveMessageEvent = {
  sender: {
    sender_type: string;
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
  message: {
    message_id: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
  };
};

export class FeishuChannel implements GatewayChannel {
  readonly id: string;

  private readonly client: Lark.Client;
  private readonly wsClient: Lark.WSClient;
  private readonly config: StoredFeishuChannelConfig;
  private readonly seenMessageIds = new Map<string, number>();

  constructor(config: StoredFeishuChannelConfig) {
    this.id = config.id;
    this.config = config;
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    this.wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: "https://open.feishu.cn",
      loggerLevel: Lark.LoggerLevel.warn,
    });
  }

  async start(context: ChannelStartContext): Promise<void> {
    console.log(
      `[channel:feishu] starting id=${this.id} agent=${this.config.agentId ?? "default"} appId=${maskSecret(this.config.appId)}`,
    );
    const dispatcher = new Lark.EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
      loggerLevel: Lark.LoggerLevel.warn,
    }).register({
      "im.message.receive_v1": async (data: FeishuReceiveMessageEvent) => {
        await this.handleInboundEvent(context, data);
      },
    });

    await this.wsClient.start({
      eventDispatcher: dispatcher,
    });
    console.log(`[channel:feishu] websocket connected id=${this.id}`);
  }

  stop(): void {
    this.wsClient.close({ force: true });
    console.log(`[channel:feishu] websocket closed id=${this.id}`);
  }

  async sendMessage(delivery: ChannelDelivery): Promise<void> {
    const replyMessageId = delivery.session.metadata?.[FEISHU_REPLY_MESSAGE_ID];
    const chatId = delivery.session.metadata?.[FEISHU_CHAT_ID];
    const threadId = delivery.session.metadata?.[FEISHU_THREAD_ID];
    const replyMode = resolveReplyMode(this.config);
    const parsed = await parseFeishuDeliveryContent(delivery.content);
    const mediaItems = deduplicateMediaItems([
      ...(delivery.media ?? []),
      ...parsed.attachmentPaths.map((attachmentPath) => ({
        kind: classifyFeishuAttachment(attachmentPath).kind,
        path: attachmentPath,
      })),
    ]);

    if (parsed.text) {
      await this.sendFeishuPayload({
        session: delivery.session,
        replyMode,
        replyMessageId,
        chatId,
        payload: buildFeishuOutboundPayload(this.config, parsed.text),
      });
    }

    for (const media of mediaItems) {
      await this.sendAttachment({
        session: delivery.session,
        replyMode,
        replyMessageId,
        chatId,
        media,
      });
    }
  }

  private async sendFeishuPayload(input: {
    session: ChannelDelivery["session"];
    replyMode: "chat" | "reply" | "thread";
    replyMessageId?: string;
    chatId?: string;
    threadId?: string;
    payload: ReturnType<typeof buildFeishuOutboundPayload>;
  }): Promise<void> {
    const { session, replyMode, replyMessageId, chatId, payload } = input;
    if ((replyMode === "reply" || replyMode === "thread") && replyMessageId) {
      console.log(
        `[channel:feishu] replying id=${this.id} mode=${replyMode} format=${payload.msgType} agent=${session.agentId ?? "default"} session=${session.sessionId} replyMessageId=${replyMessageId}`,
      );
      const response = await this.client.im.message.reply({
        path: {
          message_id: replyMessageId,
        },
        data: {
          content: payload.content,
          msg_type: payload.msgType,
          reply_in_thread: replyMode === "thread",
        },
      });
      logFeishuApiResult("message.reply", response);
      return;
    }

    if (!chatId) {
      throw new Error("Missing Feishu chat metadata for outbound delivery.");
    }

    console.log(
      `[channel:feishu] sending id=${this.id} mode=chat format=${payload.msgType} agent=${session.agentId ?? "default"} session=${session.sessionId} chatId=${chatId}`,
    );
    const response = await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        content: payload.content,
        msg_type: payload.msgType,
      },
    });
    logFeishuApiResult("message.create", response);
  }

  private async sendAttachment(input: {
    session: ChannelDelivery["session"];
    replyMode: "chat" | "reply" | "thread";
    replyMessageId?: string;
    chatId?: string;
    media: ChannelMedia;
  }): Promise<void> {
    const attachment = classifyFeishuAttachment(input.media.path);
    const fileName = input.media.fileName || path.basename(input.media.path);
    console.log(
      `[channel:feishu] attachment id=${this.id} agent=${input.session.agentId ?? "default"} session=${input.session.sessionId} path=${input.media.path} kind=${attachment.kind}`,
    );
    if (attachment.kind === "image") {
      const uploaded = await this.client.im.image.create({
        data: {
          image_type: "message",
          image: createReadStream(input.media.path),
        },
      });
      logFeishuApiResult("image.create", uploaded);
      if (!uploaded?.image_key) {
        throw new Error(`Failed to upload image attachment: ${input.media.path}`);
      }

      await this.sendAttachmentMessage({
        session: input.session,
        replyMode: input.replyMode,
        chatId: input.chatId,
        payload: {
          msgType: "image",
          content: JSON.stringify({ image_key: uploaded.image_key }),
        },
      });
      return;
    }

    const uploaded = await this.uploadFileAttachment(input.media.path, attachment.uploadFileType, fileName);
    if (!uploaded?.file_key) {
      throw new Error(`Failed to upload file attachment: ${input.media.path}`);
    }

    await this.sendAttachmentMessage({
      session: input.session,
      replyMode: input.replyMode,
      chatId: input.chatId,
      payload: {
        msgType: "file",
        content: buildFeishuFileMessageContent(uploaded.file_key, attachment.messageFileType, fileName),
      },
    });
  }

  private async uploadFileAttachment(
    attachmentPath: string,
    fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
    fileName: string,
  ): Promise<{ file_key?: string | undefined } | null> {
    try {
      const response = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
        },
        files: {
          file: {
            path: attachmentPath,
          },
        },
      } as never);
      logFeishuApiResult("file.create", response);
      return response;
    } catch (error) {
      console.warn(
        `[channel:feishu] path upload failed id=${this.id} path=${attachmentPath} fileType=${fileType}; falling back to stream upload`,
        formatFeishuError(error),
      );
      const response = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: createReadStream(attachmentPath),
        },
      });
      logFeishuApiResult("file.create", response);
      return response;
    }
  }

  private async sendAttachmentMessage(input: {
    session: ChannelDelivery["session"];
    replyMode: "chat" | "reply" | "thread";
    chatId?: string;
    payload: {
      msgType: "image" | "file";
      content: string;
    };
  }): Promise<void> {
    const target = resolveFeishuSendTarget(input.chatId);
    console.log(
      `[channel:feishu] sending attachment id=${this.id} mode=${target.receiveIdType} format=${input.payload.msgType} agent=${input.session.agentId ?? "default"} session=${input.session.sessionId} target=${target.receiveId}`,
    );
    const response = await this.client.im.message.create({
      params: {
        receive_id_type: target.receiveIdType,
      },
      data: {
        receive_id: target.receiveId,
        msg_type: input.payload.msgType,
        content: input.payload.content,
      },
    });
    logFeishuApiResult("message.create", response);
  }

  private async handleInboundEvent(
    context: ChannelStartContext,
    data: FeishuReceiveMessageEvent,
  ): Promise<void> {
    if (data.sender.sender_type !== "user") {
      console.log(`[channel:feishu] ignored senderType=${data.sender.sender_type} id=${this.id}`);
      return;
    }

    console.log(
      `[channel:feishu] inbound id=${this.id} messageId=${data.message.message_id} chatId=${data.message.chat_id} threadId=${data.message.thread_id ?? "-"} type=${data.message.message_type}`,
    );

    if (!this.shouldHandleMessage(data.message.message_id)) {
      console.log(
        `[channel:feishu] deduplicated id=${this.id} messageId=${data.message.message_id} chatId=${data.message.chat_id}`,
      );
      return;
    }

    const message = toChannelInboundMessage(this.config, data);
    if (!message) {
      await this.replyUnsupportedMessage(data);
      return;
    }

    try {
      await context.handleMessage(message);
    } catch (error) {
      const content = error instanceof Error ? error.message : String(error);
      await this.replyToEvent(data, content);
    }
  }

  private async replyUnsupportedMessage(data: FeishuReceiveMessageEvent): Promise<void> {
    await this.replyToEvent(
      data,
      `Unsupported Feishu message type "${data.message.message_type}". Please send plain text.`,
    );
  }

  private async replyToEvent(data: FeishuReceiveMessageEvent, content: string): Promise<void> {
    const payload = buildFeishuOutboundPayload(this.config, content);
    await this.client.im.message.reply({
      path: {
        message_id: data.message.message_id,
      },
      data: {
        content: payload.content,
        msg_type: payload.msgType,
        reply_in_thread: resolveReplyMode(this.config) === "thread",
      },
    });
  }

  private shouldHandleMessage(messageId: string): boolean {
    return rememberMessageId(this.seenMessageIds, messageId, Date.now());
  }
}

export function createFeishuChannel(config: StoredFeishuChannelConfig): GatewayChannel {
  return new FeishuChannel(config);
}

export function toChannelInboundMessage(
  config: Pick<StoredFeishuChannelConfig, "id" | "agentId">,
  data: FeishuReceiveMessageEvent,
): ChannelInboundMessage | undefined {
  const content = extractFeishuText(data.message.message_type, data.message.content);
  if (!content) {
    return undefined;
  }

  return {
    session: {
      agentId: config.agentId,
      channelId: config.id,
      sessionId: data.message.thread_id || data.message.chat_id,
      ...((data.sender.sender_id?.open_id
        ?? data.sender.sender_id?.user_id
        ?? data.sender.sender_id?.union_id)
        ? {
          userId: data.sender.sender_id?.open_id
            ?? data.sender.sender_id?.user_id
            ?? data.sender.sender_id?.union_id,
        }
        : {}),
      metadata: {
        [FEISHU_REPLY_MESSAGE_ID]: data.message.message_id,
        [FEISHU_CHAT_ID]: data.message.chat_id,
        ...(data.message.thread_id ? { [FEISHU_THREAD_ID]: data.message.thread_id } : {}),
      },
    },
    content,
  };
}

export function extractFeishuText(messageType: string, content: string): string | undefined {
  if (messageType !== "text") {
    return undefined;
  }

  const parsed = JSON.parse(content) as { text?: unknown };
  return typeof parsed.text === "string" ? parsed.text.trim() : undefined;
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "***";
  }

  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function resolveReplyMode(config: StoredFeishuChannelConfig): "chat" | "reply" | "thread" {
  if (config.replyMode) {
    return config.replyMode;
  }

  if (config.autoReplyInThread === true) {
    return "thread";
  }

  return "chat";
}

export function buildFeishuOutboundPayload(
  config: Pick<StoredFeishuChannelConfig, "messageFormat">,
  content: string,
): {
  msgType: "text" | "interactive" | "image" | "file";
  content: string;
} {
  if (config.messageFormat === "text") {
    return {
      msgType: "text",
      content: JSON.stringify({ text: content }),
    };
  }

  return {
    msgType: "interactive",
    content: JSON.stringify({
      config: {
        wide_screen_mode: true,
      },
      elements: [{
        tag: "markdown",
        content: normalizeFeishuMarkdown(content),
      }],
    }),
  };
}

export async function parseFeishuDeliveryContent(content: string): Promise<{
  text: string;
  attachmentPaths: string[];
}> {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n");
  const textLines: string[] = [];
  const attachmentPaths: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      textLines.push("");
      continue;
    }

    const attachmentSpec = parseAttachmentDirective(line);
    const attachmentPath = await resolveExistingAttachmentPath(attachmentSpec?.path ?? line);
    if (attachmentPath) {
      if (attachmentSpec || isLikelyAttachmentPath(line)) {
        attachmentPaths.push(attachmentPath);
        continue;
      }
    }

    if (attachmentSpec) {
      textLines.push(rawLine);
      continue;
    }

    if (attachmentPath && isLikelyAttachmentPath(line)) {
      attachmentPaths.push(attachmentPath);
      continue;
    }

    textLines.push(line);
  }

  return {
    text: textLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    attachmentPaths,
  };
}

export function classifyFeishuAttachment(filePath: string): {
  kind: "image";
} | {
  kind: "file";
  uploadFileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  messageFileType: "file" | "pdf" | "mp3" | "video";
} {
  const extension = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".bmp", ".ico"].includes(extension)) {
    return { kind: "image" };
  }
  if (extension === ".mp4") {
    return { kind: "file", uploadFileType: "mp4", messageFileType: "video" };
  }
  if (extension === ".pdf") {
    return { kind: "file", uploadFileType: "pdf", messageFileType: "pdf" };
  }
  if ([".doc", ".docx"].includes(extension)) {
    return { kind: "file", uploadFileType: "doc", messageFileType: "file" };
  }
  if ([".xls", ".xlsx", ".csv"].includes(extension)) {
    return { kind: "file", uploadFileType: "xls", messageFileType: "file" };
  }
  if ([".ppt", ".pptx"].includes(extension)) {
    return { kind: "file", uploadFileType: "ppt", messageFileType: "file" };
  }
  if ([".opus", ".mp3", ".wav", ".m4a"].includes(extension)) {
    return { kind: "file", uploadFileType: "opus", messageFileType: "mp3" };
  }

  return { kind: "file", uploadFileType: "stream", messageFileType: "file" };
}

export function buildFeishuFileMessageContent(
  fileKey: string,
  fileType: "file" | "pdf" | "mp3" | "video",
  fileName: string,
): string {
  return JSON.stringify({
    file_key: fileKey,
    file_type: fileType,
    file_name: fileName,
  });
}

function resolveFeishuSendTarget(
  chatId?: string,
): {
  receiveIdType: "chat_id";
  receiveId: string;
} {
  if (!chatId) {
    throw new Error("Missing Feishu chat metadata for outbound delivery.");
  }

  return {
    receiveIdType: "chat_id",
    receiveId: chatId,
  };
}

function logFeishuApiResult(action: string, response: unknown): void {
  const summary = summarizeFeishuResponse(response);
  console.log(`[channel:feishu] ${action} result=${summary}`);
}

function summarizeFeishuResponse(response: unknown): string {
  if (response === null || response === undefined) {
    return "null";
  }

  if (typeof response !== "object") {
    return String(response);
  }

  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

function formatFeishuError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const candidate = error as Error & {
    response?: {
      data?: unknown;
      status?: number;
    };
    code?: string;
  };

  const parts = [error.message];
  if (candidate.code) {
    parts.push(`code=${candidate.code}`);
  }
  if (candidate.response?.status) {
    parts.push(`status=${candidate.response.status}`);
  }
  if (candidate.response?.data !== undefined) {
    parts.push(`data=${summarizeFeishuResponse(candidate.response.data)}`);
  }

  return parts.join(" ");
}

function deduplicateAttachmentPaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function deduplicateMediaItems(items: ChannelMedia[]): ChannelMedia[] {
  const mediaByPath = new Map<string, ChannelMedia>();
  for (const item of items) {
    mediaByPath.set(item.path, item);
  }
  return [...mediaByPath.values()];
}

function normalizeFeishuMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+(.+)$/gm, (_, title: string) => `**${title.trim()}**`)
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    .replace(/^>\s?/gm, "> ")
    .replace(/```([\s\S]*?)```/g, (_match: string, code: string) =>
      code
        .trim()
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"))
    .replace(/`([^`\n]+)`/g, (_, inline: string) => ` ${inline} `)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "[$1]($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAttachmentDirective(line: string): {
  kind: "file" | "image" | "attachment";
  path: string;
} | undefined {
  const match = line.match(/^\[(feishu:(file|image|attachment))\]\s+(.+)$/i);
  if (!match) {
    return undefined;
  }

  const kind = match[2]?.toLowerCase();
  if (kind !== "file" && kind !== "image" && kind !== "attachment") {
    return undefined;
  }

  return {
    kind,
    path: match[3].trim(),
  };
}

function isLikelyAttachmentPath(line: string): boolean {
  if (line.includes(" ") || !line.includes(".")) {
    return false;
  }

  const extension = path.extname(line).toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".tiff",
    ".bmp",
    ".ico",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".ppt",
    ".pptx",
    ".mp4",
    ".mp3",
    ".wav",
    ".m4a",
    ".opus",
    ".txt",
    ".md",
    ".json",
    ".zip",
  ].includes(extension);
}

async function resolveExistingAttachmentPath(rawPath: string): Promise<string | undefined> {
  const candidate = path.isAbsolute(rawPath)
    ? rawPath
    : resolveWorkspacePath(rawPath);

  try {
    const fileInfo = await stat(candidate);
    if (fileInfo.isFile()) {
      return candidate;
    }
  } catch {
    if (!path.isAbsolute(rawPath)) {
      const fallback = path.resolve(getWorkspaceRoot(), rawPath);
      try {
        const fileInfo = await stat(fallback);
        if (fileInfo.isFile()) {
          return fallback;
        }
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function rememberMessageId(
  seenMessageIds: Map<string, number>,
  messageId: string,
  now: number,
  ttlMs = FEISHU_DEDUP_TTL_MS,
  maxSize = FEISHU_DEDUP_MAX_SIZE,
): boolean {
  pruneSeenMessageIds(seenMessageIds, now, ttlMs, maxSize);
  if (seenMessageIds.has(messageId)) {
    return false;
  }

  seenMessageIds.set(messageId, now);
  return true;
}

function pruneSeenMessageIds(
  seenMessageIds: Map<string, number>,
  now: number,
  ttlMs: number,
  maxSize: number,
): void {
  for (const [messageId, seenAt] of seenMessageIds) {
    if (now - seenAt > ttlMs) {
      seenMessageIds.delete(messageId);
    }
  }

  while (seenMessageIds.size >= maxSize) {
    const oldestKey = seenMessageIds.keys().next().value;
    if (!oldestKey) {
      return;
    }
    seenMessageIds.delete(oldestKey);
  }
}
