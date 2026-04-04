import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import type {
  ChannelDelivery,
  ChannelInboundMessage,
  ChannelMedia,
  ChannelStartContext,
  GatewayChannel,
  RuntimeEventDelivery,
} from "./channel.js";
import { getWorkspaceRoot, resolveWorkspacePath } from "../tools/_workspace.js";
import { formatRuntimeEvent } from "./runtime-events.js";
import {
  extractFeishuMessageText,
  type FeishuMention,
  inferFeishuInboundPlaceholder,
  normalizeFeishuMentions,
  parseFeishuMediaKeys,
  parsePostContent,
  stripLeadingFeishuBotMention,
  toFeishuMessageResourceType,
} from "./feishu-message-content.js";

const FEISHU_REPLY_MESSAGE_ID = "feishuReplyMessageId";
const FEISHU_CHAT_ID = "feishuChatId";
const FEISHU_THREAD_ID = "feishuThreadId";
const FEISHU_DEDUP_TTL_MS = 5 * 60 * 1000;
const FEISHU_DEDUP_MAX_SIZE = 2000;
const FEISHU_RETRY_ATTEMPTS = 3;
const FEISHU_RETRY_DELAY_MS = 300;
const FEISHU_PROCESSING_REACTION = "Typing";

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
    mentions?: FeishuMention[];
  };
};

type FeishuMessageResourceClient = {
  im: {
    messageReaction?: {
      create(payload?: {
        path: {
          message_id: string;
        };
        data: {
          reaction_type: {
            emoji_type: string;
          };
        };
      }): Promise<{
        code?: number;
        msg?: string;
        data?: {
          reaction_id?: string;
        };
      }>;
      delete(payload?: {
        path: {
          message_id: string;
          reaction_id: string;
        };
      }): Promise<{
        code?: number;
        msg?: string;
      }>;
    };
    messageResource: {
      get(args: {
        path: {
          message_id: string;
          file_key: string;
        };
        params: {
          type: "image" | "file";
        };
      }): Promise<unknown>;
    };
  };
};

type FeishuBotInfoClient = FeishuMessageResourceClient & {
  request?(params: {
    method: "GET";
    url: string;
    data: Record<string, never>;
    timeout?: number;
  }): Promise<{
    code?: number;
    msg?: string;
    bot?: {
      open_id?: string;
    };
    data?: {
      bot?: {
        open_id?: string;
      };
    };
  }>;
};

export class FeishuChannel implements GatewayChannel {
  readonly id: string;

  private readonly client: Lark.Client;
  private readonly wsClient: Lark.WSClient;
  private readonly config: StoredFeishuChannelConfig;
  private readonly seenMessageIds = new Map<string, number>();
  private botOpenId?: string;

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
    this.botOpenId = await resolveFeishuBotOpenId(this.client);
    console.log(`[channel:feishu] bot identity id=${this.id} openId=${this.botOpenId ?? "unknown"}`);
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

  async handleRuntimeEvent(delivery: RuntimeEventDelivery): Promise<void> {
    if (delivery.event.type === "final_output" || delivery.event.type === "prompt_ready") {
      return;
    }

    if (delivery.event.type === "assistant_message") {
      return;
    }

    const formatted = formatRuntimeEvent(delivery.event);
    if (!formatted) {
      return;
    }

    try {
      await this.sendMessage({
        session: delivery.session,
        content: formatted,
        visibleToolNames: [],
      });
    } catch (error) {
      console.warn(
        `[channel:feishu] runtime event delivery failed id=${this.id} session=${delivery.session.sessionId} type=${delivery.event.type}`,
        formatFeishuError(error),
      );
    }
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
      try {
        const response = await withFeishuRetry(
          "message.reply",
          () => this.client.im.message.reply({
            path: {
              message_id: replyMessageId,
            },
            data: {
              content: payload.content,
              msg_type: payload.msgType,
              reply_in_thread: replyMode === "thread",
            },
          }),
        );
        logFeishuApiResult("message.reply", response);
        return;
      } catch (error) {
        console.warn(
          `[channel:feishu] reply failed id=${this.id} agent=${session.agentId ?? "default"} session=${session.sessionId} replyMessageId=${replyMessageId}; falling back to message.create`,
          formatFeishuError(error),
        );
      }
    }

    if (!chatId) {
      throw new Error("Missing Feishu chat metadata for outbound delivery.");
    }

    console.log(
      `[channel:feishu] sending id=${this.id} mode=chat format=${payload.msgType} agent=${session.agentId ?? "default"} session=${session.sessionId} chatId=${chatId}`,
    );
    const response = await withFeishuRetry(
      "message.create",
      () => this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          content: payload.content,
          msg_type: payload.msgType,
        },
      }),
    );
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
      const uploaded = await withFeishuRetry(
        "image.create",
        () => this.client.im.image.create({
          data: {
            image_type: "message",
            image: createReadStream(input.media.path),
          },
        }),
      );
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
    fileType: "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
    fileName: string,
  ): Promise<{ file_key?: string | undefined } | null> {
    try {
      const response = await withFeishuRetry(
        "file.create",
        () => this.client.im.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
          },
          files: {
            file: {
              path: attachmentPath,
            },
          },
        } as never),
      );
      logFeishuApiResult("file.create", response);
      return response;
    } catch (error) {
      console.warn(
        `[channel:feishu] path upload failed id=${this.id} path=${attachmentPath} fileType=${fileType}; falling back to stream upload`,
        formatFeishuError(error),
      );
      const response = await withFeishuRetry(
        "file.create",
        () => this.client.im.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
            file: createReadStream(attachmentPath),
          },
        } as never),
      );
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
    const response = await withFeishuRetry(
      "message.create",
      () => this.client.im.message.create({
        params: {
          receive_id_type: target.receiveIdType,
        },
        data: {
          receive_id: target.receiveId,
          msg_type: input.payload.msgType,
          content: input.payload.content,
        },
      }),
    );
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

    if (!isFeishuBotMentioned(data, this.botOpenId)) {
      console.log(
        `[channel:feishu] ignored unmentioned message id=${this.id} messageId=${data.message.message_id} chatId=${data.message.chat_id}`,
      );
      return;
    }

    const reactionId = await this.addProcessingReaction(data.message.message_id);
    try {
    const message = await toChannelInboundMessage(this.config, data, {
      client: this.client,
      botOpenId: this.botOpenId,
    });
      if (!message) {
        await this.replyUnsupportedMessage(data);
        return;
      }

      await context.handleMessage(message);
    } catch (error) {
      const content = error instanceof Error ? error.message : String(error);
      await this.replyToEvent(data, content);
    } finally {
      await this.removeProcessingReaction(data.message.message_id, reactionId);
    }
  }

  private async addProcessingReaction(messageId: string): Promise<string | undefined> {
    if (!this.client.im.messageReaction?.create) {
      return undefined;
    }

    try {
      const response = await withFeishuRetry(
        "messageReaction.create",
        () => this.client.im.messageReaction!.create({
          path: {
            message_id: messageId,
          },
          data: {
            reaction_type: {
              emoji_type: FEISHU_PROCESSING_REACTION,
            },
          },
        }),
      );
      if (response?.code !== undefined && response.code !== 0) {
        console.warn(
          `[channel:feishu] reaction create failed id=${this.id} messageId=${messageId} msg=${response.msg || `code ${response.code}`}`,
        );
        return undefined;
      }
      const reactionId = response?.data?.reaction_id?.trim() || undefined;
      if (reactionId) {
        console.log(
          `[channel:feishu] reaction start id=${this.id} messageId=${messageId} reactionId=${reactionId} emoji=${FEISHU_PROCESSING_REACTION}`,
        );
      }
      return reactionId;
    } catch (error) {
      console.warn(
        `[channel:feishu] reaction create failed id=${this.id} messageId=${messageId}`,
        formatFeishuError(error),
      );
      return undefined;
    }
  }

  private async removeProcessingReaction(messageId: string, reactionId?: string): Promise<void> {
    if (!reactionId || !this.client.im.messageReaction?.delete) {
      return;
    }

    try {
      const response = await withFeishuRetry(
        "messageReaction.delete",
        () => this.client.im.messageReaction!.delete({
          path: {
            message_id: messageId,
            reaction_id: reactionId,
          },
        }),
      );
      if (response?.code !== undefined && response.code !== 0) {
        console.warn(
          `[channel:feishu] reaction delete failed id=${this.id} messageId=${messageId} reactionId=${reactionId} msg=${response.msg || `code ${response.code}`}`,
        );
        return;
      }
      console.log(
        `[channel:feishu] reaction end id=${this.id} messageId=${messageId} reactionId=${reactionId}`,
      );
    } catch (error) {
      console.warn(
        `[channel:feishu] reaction delete failed id=${this.id} messageId=${messageId} reactionId=${reactionId}`,
        formatFeishuError(error),
      );
    }
  }

  private async replyUnsupportedMessage(data: FeishuReceiveMessageEvent): Promise<void> {
    await this.replyToEvent(
      data,
      `Unsupported Feishu message type "${data.message.message_type}". Please send text or a supported attachment.`,
    );
  }

  private async replyToEvent(data: FeishuReceiveMessageEvent, content: string): Promise<void> {
    const payload = buildFeishuOutboundPayload(this.config, content);
    try {
      const response = await withFeishuRetry(
        "message.reply",
        () => this.client.im.message.reply({
          path: {
            message_id: data.message.message_id,
          },
          data: {
            content: payload.content,
            msg_type: payload.msgType,
            reply_in_thread: resolveReplyMode(this.config) === "thread",
          },
        }),
      );
      logFeishuApiResult("message.reply", response);
    } catch (error) {
      console.warn(
        `[channel:feishu] replyToEvent failed id=${this.id} messageId=${data.message.message_id} chatId=${data.message.chat_id}`,
        formatFeishuError(error),
      );
      const response = await withFeishuRetry(
        "message.create",
        () => this.client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: data.message.chat_id,
            content: payload.content,
            msg_type: payload.msgType,
          },
        }),
      );
      logFeishuApiResult("message.create", response);
    }
  }

  private shouldHandleMessage(messageId: string): boolean {
    return rememberMessageId(this.seenMessageIds, messageId, Date.now());
  }
}

export function createFeishuChannel(config: StoredFeishuChannelConfig): GatewayChannel {
  return new FeishuChannel(config);
}

export async function toChannelInboundMessage(
  config: Pick<StoredFeishuChannelConfig, "id" | "agentId">,
  data: FeishuReceiveMessageEvent,
  options: {
    client?: FeishuMessageResourceClient;
    botOpenId?: string;
  } = {},
): Promise<ChannelInboundMessage | undefined> {
  const content = normalizeFeishuInboundContent(
    extractFeishuText(data.message.message_type, data.message.content),
    data.message,
    options.botOpenId,
  );
  const media = await resolveFeishuInboundMedia({
    client: options.client,
    data,
  });
  if (!content && media.length === 0) {
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
    content: content || inferFeishuInboundPlaceholder(data.message.message_type),
    ...(media.length > 0 ? { media } : {}),
  };
}

export function extractFeishuText(messageType: string, content: string): string | undefined {
  return extractFeishuMessageText(messageType, content);
}

export function isFeishuBotMentioned(
  event: Pick<FeishuReceiveMessageEvent, "message">,
  botOpenId?: string,
): boolean {
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return false;
  }

  const mentions = event.message.mentions ?? [];
  if (mentions.some((mention) => mention.id.open_id === normalizedBotOpenId)) {
    return true;
  }

  if (event.message.message_type === "post") {
    return parsePostContent(event.message.content).mentionedOpenIds.some((id) => id === normalizedBotOpenId);
  }

  return false;
}

function normalizeFeishuInboundContent(
  content: string | undefined,
  message: FeishuReceiveMessageEvent["message"],
  botOpenId?: string,
): string | undefined {
  const trimmed = content?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedMentions = normalizeFeishuMentions(trimmed, message.mentions, botOpenId);
  const botMentionNames = (message.mentions ?? [])
    .filter((mention) => mention.id.open_id === botOpenId)
    .map((mention) => mention.name)
    .filter((name, index, array) => Boolean(name) && array.indexOf(name) === index);
  const stripped = stripLeadingFeishuBotMention(normalizedMentions, botMentionNames);

  return stripped || undefined;
}

async function resolveFeishuInboundMedia(input: {
  client?: FeishuMessageResourceClient;
  data: FeishuReceiveMessageEvent;
}): Promise<ChannelMedia[]> {
  if (!input.client) {
    return [];
  }

  const { message } = input.data;
  if (message.message_type === "post") {
    return resolveFeishuPostMedia(input.client, message);
  }

  const resource = parseFeishuMediaKeys(message.content, message.message_type);
  const fileKey = message.message_type === "image" ? resource.imageKey : resource.fileKey;
  if (!fileKey) {
    return [];
  }

  const saved = await downloadAndPersistFeishuResource({
    client: input.client,
    messageId: message.message_id,
    messageType: message.message_type,
    fileKey,
    fileName: resource.fileName,
  });
  return saved ? [saved] : [];
}

async function resolveFeishuPostMedia(
  client: FeishuMessageResourceClient,
  message: FeishuReceiveMessageEvent["message"],
): Promise<ChannelMedia[]> {
  const parsed = parsePostContent(message.content);
  const media: ChannelMedia[] = [];

  for (const imageKey of parsed.imageKeys) {
    const saved = await downloadAndPersistFeishuResource({
      client,
      messageId: message.message_id,
      messageType: "image",
      fileKey: imageKey,
    });
    if (saved) {
      media.push(saved);
    }
  }

  for (const item of parsed.mediaKeys) {
    const saved = await downloadAndPersistFeishuResource({
      client,
      messageId: message.message_id,
      messageType: "file",
      fileKey: item.fileKey,
      fileName: item.fileName,
    });
    if (saved) {
      media.push(saved);
    }
  }

  return media;
}

async function downloadAndPersistFeishuResource(input: {
  client: FeishuMessageResourceClient;
  messageId: string;
  messageType: string;
  fileKey: string;
  fileName?: string;
}): Promise<ChannelMedia | undefined> {
  try {
    const downloaded = await downloadFeishuMessageResource({
      client: input.client,
      messageId: input.messageId,
      fileKey: input.fileKey,
      type: toFeishuMessageResourceType(input.messageType),
    });
    const saved = await saveFeishuInboundResource({
      messageId: input.messageId,
      messageType: input.messageType,
      buffer: downloaded.buffer,
      fileName: downloaded.fileName ?? input.fileName,
      contentType: downloaded.contentType,
    });
    console.log(
      `[channel:feishu] inbound resource id=${input.messageId} type=${input.messageType} saved=${saved.path}`,
    );
    return saved;
  } catch (error) {
    console.warn(
      `[channel:feishu] inbound resource failed id=${input.messageId} type=${input.messageType} fileKey=${input.fileKey}`,
      formatFeishuError(error),
    );
    return undefined;
  }
}

async function downloadFeishuMessageResource(input: {
  client: FeishuMessageResourceClient;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
}): Promise<{
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}> {
  const response = await withFeishuRetry(
    "messageResource.get",
    () => input.client.im.messageResource.get({
      path: {
        message_id: input.messageId,
        file_key: input.fileKey,
      },
      params: {
        type: input.type,
      },
    }),
  );

  const buffer = await readFeishuResponseBuffer(response);
  const metadata = extractFeishuDownloadMetadata(response);
  return {
    buffer,
    contentType: metadata.contentType,
    fileName: metadata.fileName,
  };
}

async function saveFeishuInboundResource(input: {
  messageId: string;
  messageType: string;
  buffer: Buffer;
  fileName?: string;
  contentType?: string;
}): Promise<ChannelMedia> {
  const directory = path.join(getWorkspaceRoot(), ".runtime", "feishu", "inbound", sanitizePathSegment(input.messageId));
  await mkdir(directory, { recursive: true });

  const baseName = resolveInboundFileName(input.fileName, input.messageType, input.contentType);
  const targetPath = await createUniqueFilePath(directory, baseName);
  await writeFile(targetPath, input.buffer);

  return {
    kind: input.messageType === "image" ? "image" : "file",
    path: targetPath,
    fileName: path.basename(targetPath),
  };
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
  uploadFileType: "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  messageFileType: "file" | "pdf" | "video";
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
  if ([".mp3", ".opus", ".wav", ".m4a"].includes(extension)) {
    return { kind: "file", uploadFileType: "stream", messageFileType: "file" };
  }

  return { kind: "file", uploadFileType: "stream", messageFileType: "file" };
}

export function buildFeishuFileMessageContent(
  fileKey: string,
  fileType: "file" | "pdf" | "video",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFeishuHeader(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }

  return undefined;
}

function decodeDispositionFileName(value: string): string | undefined {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim();
}

async function readFeishuResponseBuffer(response: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }

  const candidate = response as {
    code?: number;
    msg?: string;
    data?: Buffer | ArrayBuffer;
    writeFile?: (targetPath: string) => Promise<void>;
    getReadableStream?: () => AsyncIterable<Buffer | Uint8Array | string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
  };

  if (candidate.code !== undefined && candidate.code !== 0) {
    throw new Error(candidate.msg || `Feishu API error code ${candidate.code}`);
  }
  if (candidate.data && Buffer.isBuffer(candidate.data)) {
    return candidate.data;
  }
  if (candidate.data instanceof ArrayBuffer) {
    return Buffer.from(candidate.data);
  }
  if (typeof candidate.writeFile === "function") {
    const tempPath = path.join(getWorkspaceRoot(), ".runtime", "feishu", `download-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await mkdir(path.dirname(tempPath), { recursive: true });
    await candidate.writeFile(tempPath);
    try {
      return await readFile(tempPath);
    } finally {
      try {
        await rm(tempPath, { force: true });
      } catch {
        // Best-effort cleanup for SDK temp downloads.
      }
    }
  }

  const stream = typeof candidate.getReadableStream === "function"
    ? candidate.getReadableStream()
    : candidate[Symbol.asyncIterator]
      ? (candidate as AsyncIterable<Buffer | Uint8Array | string>)
      : undefined;
  if (stream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error(`Unexpected Feishu download response: ${summarizeFeishuResponse(response)}`);
}

function extractFeishuDownloadMetadata(response: unknown): {
  contentType?: string;
  fileName?: string;
} {
  const candidate = response as {
    headers?: Record<string, unknown>;
    header?: Record<string, unknown>;
    contentType?: string;
    mime_type?: string;
    file_name?: string;
    fileName?: string;
    data?: {
      contentType?: string;
      mime_type?: string;
      file_name?: string;
      fileName?: string;
    };
  };
  const headers = isRecord(candidate.headers) ? candidate.headers : isRecord(candidate.header) ? candidate.header : undefined;
  const contentType = readFeishuHeader(headers, "content-type")
    ?? candidate.contentType
    ?? candidate.mime_type
    ?? candidate.data?.contentType
    ?? candidate.data?.mime_type;
  const disposition = readFeishuHeader(headers, "content-disposition");
  const fileName = (disposition ? decodeDispositionFileName(disposition) : undefined)
    ?? candidate.file_name
    ?? candidate.fileName
    ?? candidate.data?.file_name
    ?? candidate.data?.fileName;
  return { contentType, fileName };
}

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^\w.-]+/g, "_");
  return normalized || "resource";
}

function extensionFromContentType(contentType?: string): string {
  switch ((contentType ?? "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    default:
      return "";
  }
}

function defaultFileNameForMessageType(messageType: string): string {
  switch (messageType) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
    case "media":
      return "video";
    case "sticker":
      return "sticker";
    default:
      return "attachment";
  }
}

function resolveInboundFileName(
  fileName: string | undefined,
  messageType: string,
  contentType?: string,
): string {
  const providedName = sanitizePathSegment(fileName ?? "");
  if (providedName !== "resource" && path.extname(providedName)) {
    return providedName;
  }

  const baseName = providedName !== "resource"
    ? providedName
    : defaultFileNameForMessageType(messageType);
  const parsed = path.parse(baseName);
  const extension = parsed.ext || extensionFromContentType(contentType);
  return extension ? `${parsed.name}${extension}` : baseName;
}

async function createUniqueFilePath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let attempt = 0;

  while (true) {
    const candidateName = attempt === 0
      ? `${parsed.name}${parsed.ext}`
      : `${parsed.name}-${attempt}${parsed.ext}`;
    const candidatePath = path.join(directory, candidateName);
    try {
      await stat(candidatePath);
      attempt += 1;
    } catch {
      return candidatePath;
    }
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

export function isRetryableFeishuError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    message?: string;
    response?: { status?: number };
  } | undefined;
  const code = candidate?.code?.toUpperCase();
  const message = candidate?.message?.toUpperCase() ?? "";
  const status = candidate?.response?.status;

  if (status !== undefined && status >= 500) {
    return true;
  }

  return code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ECONNABORTED"
    || code === "EPIPE"
    || message.includes("ECONNRESET")
    || message.includes("ETIMEDOUT")
    || message.includes("SOCKET HANG UP");
}

async function resolveFeishuBotOpenId(client: FeishuBotInfoClient): Promise<string | undefined> {
  if (typeof client.request !== "function") {
    return undefined;
  }

  try {
    const response = await withFeishuRetry(
      "bot.info",
      () => client.request!({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
        timeout: 10_000,
      }),
    );
    if (response?.code !== undefined && response.code !== 0) {
      console.warn(
        `[channel:feishu] bot.info returned error ${response.msg || `code ${response.code}`}`,
      );
      return undefined;
    }
    return response?.bot?.open_id?.trim() || response?.data?.bot?.open_id?.trim() || undefined;
  } catch (error) {
    console.warn(`[channel:feishu] bot.info probe failed id=unknown`, formatFeishuError(error));
    return undefined;
  }
}

async function withFeishuRetry<T>(
  action: string,
  operation: () => Promise<T>,
  attempts = FEISHU_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableFeishuError(error);
      console.warn(
        `[channel:feishu] ${action} failed attempt=${attempt}/${attempts} retryable=${retryable}`,
        formatFeishuError(error),
      );
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await sleep(FEISHU_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match: string, alt: string) =>
      alt.trim() ? `[image: ${alt.trim()}]` : "[image]")
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (_match: string, alt: string) =>
      alt.trim() ? `[image: ${alt.trim()}]` : "[image]")
    .replace(/<img\b[^>]*>/gi, "[image]")
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
