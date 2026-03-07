import type { RuntimeConfig } from "../core/config/agent-config.js";
import type { StoredChannelConfig } from "../core/config/config-store.js";
import { createFeishuChannel } from "./feishu-channel.js";
import { createHttpChannel } from "./http-channel.js";
import type { GatewayChannel } from "./channel.js";

export type {
  ChannelDelivery,
  ChannelInboundMessage,
  ChannelSession,
  ChannelStartContext,
  GatewayChannel,
} from "./channel.js";

export { FeishuChannel, createFeishuChannel, extractFeishuText, toChannelInboundMessage } from "./feishu-channel.js";
export { createHttpChannel } from "./http-channel.js";

export function createConfiguredChannels(config: RuntimeConfig): GatewayChannel[] {
  return config.channels.map((channelConfig) => createChannel(channelConfig));
}

export function createChannel(config: StoredChannelConfig): GatewayChannel {
  if (config.type === "feishu") {
    return createFeishuChannel(config);
  }

  return createHttpChannel(config.id);
}
