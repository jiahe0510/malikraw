import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getMalikrawHomeDirectory } from "../core/config/config-store.js";

type ServiceMetadata = {
  pid: number;
  startedAt: string;
  command: string;
  logPath: string;
};

export type ServiceStatus =
  | {
      running: true;
      pid: number;
      startedAt: string;
      logPath: string;
      command: string;
    }
  | {
      running: false;
      reason: "missing" | "stale";
    };

export function startBackgroundService(): ServiceStatus {
  const current = getServiceStatus();
  if (current.running) {
    return current;
  }

  ensureServiceDirectory();

  const cliEntry = path.resolve(process.cwd(), "dist/cli.js");
  const logPath = getServiceLogPath();
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [cliEntry, "serve"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  child.unref();

  const metadata: ServiceMetadata = {
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    command: `${process.execPath} ${cliEntry} serve`,
    logPath,
  };
  writeMetadata(metadata);

  return {
    running: true,
    pid: metadata.pid,
    startedAt: metadata.startedAt,
    logPath: metadata.logPath,
    command: metadata.command,
  };
}

export function stopBackgroundService(): ServiceStatus {
  const status = getServiceStatus();
  if (!status.running) {
    clearServiceMetadata();
    return status;
  }

  process.kill(status.pid, "SIGTERM");
  clearServiceMetadata();

  return {
    running: false,
    reason: "missing",
  };
}

export function restartBackgroundService(): ServiceStatus {
  const current = getServiceStatus();
  if (current.running) {
    process.kill(current.pid, "SIGTERM");
    clearServiceMetadata();
  }

  return startBackgroundService();
}

export function getServiceStatus(): ServiceStatus {
  const metadata = readMetadata();
  if (!metadata) {
    return {
      running: false,
      reason: "missing",
    };
  }

  if (!isProcessAlive(metadata.pid)) {
    clearServiceMetadata();
    return {
      running: false,
      reason: "stale",
    };
  }

  return {
    running: true,
    pid: metadata.pid,
    startedAt: metadata.startedAt,
    logPath: metadata.logPath,
    command: metadata.command,
  };
}

export function getServicePidFilePath(): string {
  return path.join(getServiceDirectory(), "gateway.json");
}

export function getServiceLogPath(): string {
  return path.join(getServiceDirectory(), "gateway.log");
}

function getServiceDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), ".runtime", "service");
}

function ensureServiceDirectory(): void {
  mkdirSync(getServiceDirectory(), { recursive: true });
}

function readMetadata(): ServiceMetadata | undefined {
  try {
    const raw = readFileSync(getServicePidFilePath(), "utf8");
    return JSON.parse(raw) as ServiceMetadata;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function writeMetadata(metadata: ServiceMetadata): void {
  writeFileSync(getServicePidFilePath(), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function clearServiceMetadata(): void {
  rmSync(getServicePidFilePath(), { force: true });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export function getServiceLogInfo(): { logPath: string; sizeBytes: number | undefined } {
  const logPath = getServiceLogPath();
  try {
    const stats = statSync(logPath);
    return {
      logPath,
      sizeBytes: stats.size,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        logPath,
        sizeBytes: undefined,
      };
    }

    throw error;
  }
}
