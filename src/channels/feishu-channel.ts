import * as Lark from "@larksuiteoapi/node-sdk";

import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import type { ChannelDelivery, ChannelInboundMessage, ChannelStartContext, GatewayChannel } from "./channel.js";

const FEISHU_REPLY_MESSAGE_ID = "feishuReplyMessageId";
const FEISHU_CHAT_ID = "feishuChatId";
const FEISHU_THREAD_ID = "feishuThreadId";
const FEISHU_DEDUP_TTL_MS = 5 * 60 * 1000;
const FEISHU_DEDUP_MAX_SIZE = 2000;

type FeishuReceiveMessageEvent = {
  sender: {
    sender_type: string;
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
    const content = JSON.stringify({
      text: delivery.content,
    });
    const replyMode = resolveReplyMode(this.config);

    if ((replyMode === "reply" || replyMode === "thread") && replyMessageId) {
      console.log(
        `[channel:feishu] replying id=${this.id} mode=${replyMode} agent=${delivery.session.agentId ?? "default"} session=${delivery.session.sessionId} replyMessageId=${replyMessageId}`,
      );
      await this.client.im.v1.message.reply({
        path: {
          message_id: replyMessageId,
        },
        data: {
          content,
          msg_type: "text",
          reply_in_thread: replyMode === "thread",
        },
      });
      return;
    }

    if (!chatId) {
      throw new Error("Missing Feishu chat metadata for outbound delivery.");
    }

    console.log(
      `[channel:feishu] sending id=${this.id} mode=chat agent=${delivery.session.agentId ?? "default"} session=${delivery.session.sessionId} chatId=${chatId}`,
    );
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        content,
        msg_type: "text",
      },
    });
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
    await this.client.im.v1.message.reply({
      path: {
        message_id: data.message.message_id,
      },
      data: {
        content: JSON.stringify({ text: content }),
        msg_type: "text",
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
