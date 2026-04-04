import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../core/agent/types.js";
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
    logGatewayEvent("inbound", {
      traceId: session.traceId,
      agentId: session.agentId ?? "default",
      channelId: session.channelId,
      sessionId: session.sessionId,
      historyLength: history.length,
      contentPreview: userRequest,
      mediaCount: enrichedMessage.media?.length ?? 0,
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

    logGatewayEvent("outbound", {
      traceId: session.traceId,
      agentId: session.agentId ?? "default",
      channelId: session.channelId,
      sessionId: session.sessionId,
      toolCount: result.visibleToolNames.length,
      contentPreview: result.output,
    });

    return {
      output: result.output,
      visibleToolNames: result.visibleToolNames,
      sessionMessages,
      media: result.media,
      messageDispatches: result.messageDispatches,
    };
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

      console.log(
        `[gateway:event] trace=${message.session.traceId ?? "-"} agent=${message.session.agentId ?? "default"} channel=${message.session.channelId} session=${message.session.sessionId} type=${next.value.type}`,
      );
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

    console.log(
      `[gateway:dispatch] trace=${targetSession.traceId ?? "-"} agent=${targetSession.agentId ?? "default"} channel=${targetSession.channelId} session=${targetSession.sessionId} media=${dispatch.media?.length ?? 0} preview=${JSON.stringify(truncate(dispatch.content))}`,
    );
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

function logGatewayEvent(
  direction: "inbound" | "outbound",
  payload: {
    traceId?: string;
    agentId: string;
    channelId: string;
    sessionId: string;
    contentPreview: string;
    historyLength?: number;
    toolCount?: number;
    mediaCount?: number;
  },
): void {
  const suffix = direction === "inbound"
    ? `history=${payload.historyLength ?? 0} media=${payload.mediaCount ?? 0}`
    : `tools=${payload.toolCount ?? 0}`;
  console.log(
    `[gateway:${direction}] trace=${payload.traceId ?? "-"} agent=${payload.agentId} channel=${payload.channelId} session=${payload.sessionId} ${suffix} preview=${JSON.stringify(truncate(payload.contentPreview))}`,
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
