import type { AgentMessage } from "../core/agent/types.js";
import type { AgentRuntime } from "../runtime/create-agent-runtime.js";
import type { ChannelDelivery, ChannelInboundMessage, GatewayChannel } from "./channel.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";

export type GatewayHandleMessageResult = {
  output: string;
  visibleToolNames: string[];
  sessionMessages: AgentMessage[];
  attachmentPaths: string[];
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
    logGatewayEvent("inbound", {
      agentId: message.session.agentId ?? "default",
      channelId: message.session.channelId,
      sessionId: message.session.sessionId,
      historyLength: history.length,
      contentPreview: message.content,
    });

    const result = await runtime.ask({
      userRequest: message.content,
      history,
      sessionId: message.session.sessionId,
      userId: message.session.userId ?? message.session.metadata?.userId,
      agentId: message.session.agentId,
      channelId: message.session.channelId,
      projectId: message.session.projectId ?? message.session.metadata?.projectId,
    });

    const sessionMessages = filterSessionMessages(result.messages);
    await this.sessionStore.write(message.session, sessionMessages);

    const delivery: ChannelDelivery = {
      session: message.session,
      content: result.output,
      visibleToolNames: result.visibleToolNames,
      attachmentPaths: result.attachmentPaths,
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
      attachmentPaths: result.attachmentPaths,
    };
  }

  private resolveRuntime(agentId?: string): AgentRuntime {
    if (typeof this.runtimeResolver === "function") {
      return this.runtimeResolver(agentId);
    }

    return this.runtimeResolver;
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
  },
): void {
  const suffix = direction === "inbound"
    ? `history=${payload.historyLength ?? 0}`
    : `tools=${payload.toolCount ?? 0}`;
  console.log(
    `[gateway:${direction}] agent=${payload.agentId} channel=${payload.channelId} session=${payload.sessionId} ${suffix} preview=${JSON.stringify(truncate(payload.contentPreview))}`,
  );
}

function truncate(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
