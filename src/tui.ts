import readline from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { loadRuntimeConfig } from "./core/config/agent-config.js";
import { Gateway, createAgentRuntime, type ChannelDelivery, type GatewayChannel } from "./index.js";

export async function runTui(): Promise<void> {
  const config = loadRuntimeConfig();
  const runtime = await createAgentRuntime(config);
  const gateway = new Gateway(runtime);
  const channel = createTuiChannel();
  gateway.registerChannel(channel);
  const rl = readline.createInterface({ input, output });
  const sessionId = "default";

  console.log("malikraw tui registered to gateway channel tui");
  console.log('Type a request, or "/exit" to exit.');

  while (true) {
    const question = await rl.question("> ");
    const trimmed = question.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "/exit") {
      break;
    }

    try {
      await gateway.handleMessage({
        session: {
          channelId: channel.id,
          sessionId,
        },
        content: trimmed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    }
  }

  rl.close();
}

function createTuiChannel(): GatewayChannel {
  return {
    id: "tui",
    sendMessage: (delivery: ChannelDelivery) => {
      console.log("");
      console.log(delivery.content);
      console.log("");
    },
  };
}

if (isDirectExecution()) {
  void runTui().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return import.meta.url === new URL(`file://${path.resolve(entryPath)}`).href;
}
