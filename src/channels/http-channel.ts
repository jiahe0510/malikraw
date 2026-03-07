import type { GatewayChannel } from "./channel.js";

export function createHttpChannel(id = "http"): GatewayChannel {
  return {
    id,
    sendMessage: () => {
      // HTTP callers receive the response directly from the request handler.
    },
  };
}
