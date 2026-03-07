#!/usr/bin/env node

import { loadRuntimeConfig } from "./core/config/agent-config.js";
import {
  getServiceLogInfo,
  getServiceStatus,
  restartBackgroundService,
  startBackgroundService,
  stopBackgroundService,
} from "./cli/service-manager.js";
import { startGatewayServer } from "./gateway/server.js";
import { runOnboardWizard } from "./cli/onboard.js";
import { runTui } from "./tui.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  if (command === "onboard") {
    await runOnboardWizard();
    return;
  }

  if (command === "start") {
    printServiceStatus(startBackgroundService(), "started");
    return;
  }

  if (command === "stop") {
    printServiceStatus(stopBackgroundService(), "stopped");
    return;
  }

  if (command === "restart") {
    printServiceStatus(restartBackgroundService(), "started");
    return;
  }

  if (command === "status") {
    printServiceStatus(getServiceStatus(), "status");
    return;
  }

  if (command === "serve") {
    await startGatewayServer(loadRuntimeConfig());
    return;
  }

  if (command === "tui") {
    await runTui();
    return;
  }

  printHelp();
}

function printHelp(): void {
  console.log("malikraw commands:");
  console.log("  onboard   step-by-step setup and optionally start the service");
  console.log("  start     start the gateway as a background service");
  console.log("  stop      stop the background gateway service");
  console.log("  restart   restart the background gateway service");
  console.log("  status    show background gateway service status");
  console.log("  tui       start the local tui channel");
}

function printServiceStatus(
  status: ReturnType<typeof getServiceStatus>,
  action: "started" | "stopped" | "status",
): void {
  const logInfo = getServiceLogInfo();
  if (!status.running) {
    if (action === "stopped") {
      console.log("malikraw service stopped");
      return;
    }

    console.log(`malikraw service is not running (${status.reason})`);
    console.log(`log: ${logInfo.logPath}`);
    return;
  }

  if (action === "status") {
    console.log("malikraw service is running");
  } else {
    console.log(`malikraw service ${action}`);
  }
  console.log(`pid: ${status.pid}`);
  console.log(`startedAt: ${status.startedAt}`);
  console.log(`log: ${status.logPath}`);
  if (logInfo.sizeBytes !== undefined) {
    console.log(`logSizeBytes: ${logInfo.sizeBytes}`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
