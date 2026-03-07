export type ChannelSession = {
  channelId: string;
  sessionId: string;
  metadata?: Record<string, string>;
};

export type ChannelInboundMessage = {
  session: ChannelSession;
  content: string;
};

export type ChannelDelivery = {
  session: ChannelSession;
  content: string;
  visibleToolNames: string[];
};

export interface GatewayChannel {
  id: string;
  sendMessage(delivery: ChannelDelivery): Promise<void> | void;
}
