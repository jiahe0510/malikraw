#!/usr/bin/env node

import { loadRuntimeConfig } from "./core/config/agent-config.js";
import { startGatewayServer } from "./gateway/server.js";
import { runOnboardWizard } from "./cli/onboard.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  if (command === "onboard") {
    await runOnboardWizard();
    return;
  }

  if (command === "start") {
    await startGatewayServer(loadRuntimeConfig(process.env));
    return;
  }

  printHelp();
}

function printHelp(): void {
  console.log("malikraw commands:");
  console.log("  onboard   step-by-step setup and optionally start the service");
  console.log("  start     start the gateway using saved config and env overrides");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
