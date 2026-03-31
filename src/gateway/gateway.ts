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
    const channel = this.channels.get(message.session.channelId);
    if (!channel) {
      throw new Error(`Channel "${message.session.channelId}" is not registered.`);
    }

    const runtime = this.resolveRuntime(message.session.agentId);
    const history = await this.sessionStore.read(message.session);
    const userRequest = buildInboundUserRequest(message);
    logGatewayEvent("inbound", {
      agentId: message.session.agentId ?? "default",
      channelId: message.session.channelId,
      sessionId: message.session.sessionId,
      historyLength: history.length,
      contentPreview: userRequest,
      mediaCount: message.media?.length ?? 0,
    });

    const result = await runtime.ask({
      userRequest,
      history,
      sessionId: message.session.sessionId,
      userId: message.session.userId ?? message.session.metadata?.userId,
      agentId: message.session.agentId,
      channelId: message.session.channelId,
      projectId: message.session.projectId ?? message.session.metadata?.projectId,
    });

    const sessionMessages = filterSessionMessages(result.messages);
    await this.sessionStore.write(message.session, sessionMessages);

    for (const dispatch of result.messageDispatches) {
      await this.dispatchStructuredMessage(message.session, dispatch);
    }

    const delivery: ChannelDelivery = {
      session: message.session,
      content: result.output,
      visibleToolNames: result.visibleToolNames,
      media: result.media,
    };
    await channel.sendMessage(delivery);

    logGatewayEvent("outbound", {
      agentId: message.session.agentId ?? "default",
      channelId: message.session.channelId,
      sessionId: message.session.sessionId,
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
      `[gateway:dispatch] agent=${targetSession.agentId ?? "default"} channel=${targetSession.channelId} session=${targetSession.sessionId} media=${dispatch.media?.length ?? 0} preview=${JSON.stringify(truncate(dispatch.content))}`,
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
    `[gateway:${direction}] agent=${payload.agentId} channel=${payload.channelId} session=${payload.sessionId} ${suffix} preview=${JSON.stringify(truncate(payload.contentPreview))}`,
  );
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
