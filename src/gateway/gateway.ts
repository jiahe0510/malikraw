import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../core/agent/types.js";
import { recordRuntimeLog } from "../core/observability/observability.js";
import type { AgentRuntime } from "../runtime/create-agent-runtime.js";
import type { ChannelDelivery, ChannelInboundMessage, GatewayChannel, MessageDispatch } from "./channel.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";
import type { ChannelMedia } from "../channels/channel.js";

export type GatewayHandleMessageResult = {
  output: string;
  visibleToolNames: string[];
  sessionMessages: AgentMessage[];
  media: ChannelMedia[];
  messageDispatches: MessageDispatch[];
};

export class Gateway {
  private readonly channels = new Map<string, GatewayChannel>();

  constructor(
    private readonly runtimeResolver: AgentRuntime | ((agentId?: string) => AgentRuntime),
    private readonly sessionStore: SessionStore = new InMemorySessionStore(),
  ) {}

  registerChannel(channel: GatewayChannel): void {
    this.channels.set(channel.id, channel);
  }

  listChannelIds(): string[] {
    return [...this.channels.keys()];
  }

  async handleMessage(message: ChannelInboundMessage): Promise<GatewayHandleMessageResult> {
    const session = ensureGatewayTraceId(message.session);
    const enrichedMessage = {
      ...message,
      session,
    };
    const channel = this.channels.get(session.channelId);
    if (!channel) {
      throw new Error(`Channel "${session.channelId}" is not registered.`);
    }

    const runtime = this.resolveRuntime(session.agentId);
    const history = await this.sessionStore.read(session);
    const userRequest = buildInboundUserRequest(enrichedMessage);
    const startedAt = Date.now();
    recordRuntimeLog({
      name: "query.start",
      message: "Started handling inbound query.",
      data: {
        traceId: session.traceId,
        agentId: session.agentId ?? "default",
        channelId: session.channelId,
        sessionId: session.sessionId,
        historyLength: history.length,
        mediaCount: enrichedMessage.media?.length ?? 0,
        userRequest: userRequest,
      },
    });

    const runtimeInput = {
      userRequest,
      history,
      sessionId: session.sessionId,
      userId: session.userId ?? session.metadata?.userId,
      agentId: session.agentId,
      channelId: session.channelId,
      projectId: session.projectId ?? session.metadata?.projectId,
      traceId: session.traceId,
    };
    try {
      const result = runtime.askEvents
        ? await this.consumeRuntimeEvents(channel, enrichedMessage, runtime.askEvents(runtimeInput))
        : await runtime.ask(runtimeInput);

      const sessionMessages = filterSessionMessages(result.messages);
      await this.sessionStore.write(session, sessionMessages);

      for (const dispatch of result.messageDispatches) {
        await this.dispatchStructuredMessage(session, dispatch);
      }

      const delivery: ChannelDelivery = {
        session,
        content: result.output,
        visibleToolNames: result.visibleToolNames,
        media: result.media,
      };
      await channel.sendMessage(delivery);

      recordRuntimeLog({
        name: "query.end",
        message: "Completed inbound query.",
        data: {
          traceId: session.traceId,
          agentId: session.agentId ?? "default",
          channelId: session.channelId,
          sessionId: session.sessionId,
          durationMs: Date.now() - startedAt,
          toolCount: result.visibleToolNames.length,
          mediaCount: result.media.length,
          dispatchCount: result.messageDispatches.length,
          output: result.output,
        },
      });

      return {
        output: result.output,
        visibleToolNames: result.visibleToolNames,
        sessionMessages,
        media: result.media,
        messageDispatches: result.messageDispatches,
      };
    } catch (error) {
      recordRuntimeLog({
        name: "query.fail",
        level: "error",
        message: "Inbound query failed.",
        data: {
          traceId: session.traceId,
          agentId: session.agentId ?? "default",
          channelId: session.channelId,
          sessionId: session.sessionId,
          durationMs: Date.now() - startedAt,
          error: formatUnknownError(error),
        },
      });
      throw error;
    }
  }

  private async consumeRuntimeEvents(
    channel: GatewayChannel,
    message: ChannelInboundMessage,
    stream: NonNullable<AgentRuntime["askEvents"]> extends (...args: never[]) => infer TResult ? TResult : never,
  ): Promise<Awaited<ReturnType<AgentRuntime["ask"]>>> {
    while (true) {
      const next = await stream.next();
      if (next.done) {
        return next.value;
      }

      await channel.handleRuntimeEvent?.({
        session: message.session,
        event: next.value,
      });
    }
  }

  private resolveRuntime(agentId?: string): AgentRuntime {
    if (typeof this.runtimeResolver === "function") {
      return this.runtimeResolver(agentId);
    }

    return this.runtimeResolver;
  }

  private async dispatchStructuredMessage(
    baseSession: ChannelInboundMessage["session"],
    dispatch: MessageDispatch,
  ): Promise<void> {
    const targetSession = {
      ...baseSession,
      ...(dispatch.session ?? {}),
      metadata: baseSession.metadata,
    };
    const targetChannel = this.channels.get(targetSession.channelId);
    if (!targetChannel) {
      throw new Error(`Channel "${targetSession.channelId}" is not registered.`);
    }

    await targetChannel.sendMessage({
      session: targetSession,
      content: dispatch.content,
      visibleToolNames: [],
      media: dispatch.media,
    });
  }
}

function filterSessionMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    message.role === "user" || message.role === "assistant" || message.role === "tool",
  );
}

function ensureGatewayTraceId(session: ChannelInboundMessage["session"]): ChannelInboundMessage["session"] {
  if (session.traceId) {
    return session;
  }

  return {
    ...session,
    traceId: `qry_${randomUUID().replace(/-/g, "")}`,
  };
}

function buildInboundUserRequest(message: ChannelInboundMessage): string {
  const content = message.content.trim();
  if (!message.media?.length) {
    return content;
  }

  const attachmentLines = message.media.map((media) => `- ${media.path}`);
  const sections = [];
  if (content) {
    sections.push(content);
  }
  sections.push(["Attachments:", ...attachmentLines].join("\n"));
  return sections.join("\n\n");
}

function truncate(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function formatUnknownError(error: unknown): Record<string, unknown> | string {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return String(error);
}
