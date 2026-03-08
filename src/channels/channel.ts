export type ChannelSession = {
  agentId?: string;
  userId?: string;
  projectId?: string;
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
  attachmentPaths?: string[];
};

export type ChannelStartContext = {
  handleMessage(message: ChannelInboundMessage): Promise<unknown>;
};

export interface GatewayChannel {
  id: string;
  start?(context: ChannelStartContext): Promise<void> | void;
  stop?(): Promise<void> | void;
  sendMessage(delivery: ChannelDelivery): Promise<void> | void;
}
