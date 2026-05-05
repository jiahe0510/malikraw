import type { RuntimeConfig } from "../core/config/agent-config.js";
import type { StoredChannelConfig } from "../core/config/config-store.js";
import { createFeishuChannel } from "./feishu-channel.js";
import type { GatewayChannel } from "./channel.js";

export type {
  ChannelMedia,
  ChannelDelivery,
  ChannelInboundMessage,
  ChannelSession,
  MessageDispatch,
  ChannelStartContext,
  GatewayChannel,
} from "./channel.js";

export { FeishuChannel, createFeishuChannel, extractFeishuText, toChannelInboundMessage } from "./feishu-channel.js";
export { formatRuntimeEvent } from "./runtime-events.js";

export function createConfiguredChannels(config: RuntimeConfig): GatewayChannel[] {
  return config.channels.map((channelConfig) => createChannel(channelConfig));
}

export function createChannel(config: StoredChannelConfig): GatewayChannel {
  return createFeishuChannel(config);
}
