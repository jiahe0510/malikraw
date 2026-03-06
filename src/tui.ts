import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadRuntimeConfig } from "./core/config/agent-config.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const gatewayUrl = `http://127.0.0.1:${config.gatewayPort}`;
  const rl = readline.createInterface({ input, output });

  console.log(`malikraw tui connected to ${gatewayUrl}`);
  console.log('Type a request, or ":quit" to exit.');

  while (true) {
    const question = await rl.question("> ");
    const trimmed = question.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === ":quit" || trimmed === ":q" || trimmed === "exit") {
      break;
    }

    try {
      const response = await fetch(`${gatewayUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: trimmed }),
      });
      const payload = await response.json() as {
        ok?: boolean;
        output?: string;
        error?: string;
        visibleToolNames?: string[];
      };

      if (!response.ok || !payload.ok) {
        console.error(payload.error ?? `Request failed with ${response.status}`);
        continue;
      }

      console.log("");
      console.log(payload.output ?? "");
      if (payload.visibleToolNames?.length) {
        console.log("");
        console.log(`visible tools: ${payload.visibleToolNames.join(", ")}`);
      }
      console.log("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    }
  }

  rl.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
