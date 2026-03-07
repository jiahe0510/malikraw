import type { AgentMessage } from "../core/agent/types.js";
import type { AgentRuntime } from "../runtime/create-agent-runtime.js";
import type { ChannelDelivery, ChannelInboundMessage, GatewayChannel } from "./channel.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";

export type GatewayHandleMessageResult = {
  output: string;
  visibleToolNames: string[];
  sessionMessages: AgentMessage[];
};

export class Gateway {
  private readonly channels = new Map<string, GatewayChannel>();

  constructor(
    private readonly runtime: AgentRuntime,
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

    const history = await this.sessionStore.read(message.session);
    const result = await this.runtime.ask({
      userRequest: message.content,
      history,
    });

    const sessionMessages = filterSessionMessages(result.messages);
    await this.sessionStore.write(message.session, sessionMessages);

    const delivery: ChannelDelivery = {
      session: message.session,
      content: result.output,
      visibleToolNames: result.visibleToolNames,
    };
    await channel.sendMessage(delivery);

    return {
      output: result.output,
      visibleToolNames: result.visibleToolNames,
      sessionMessages,
    };
  }
}

function filterSessionMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    message.role === "user" || message.role === "assistant" || message.role === "tool",
  );
}
