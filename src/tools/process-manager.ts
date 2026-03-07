import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { createProcessLogDirectory, getWorkspaceRoot, readOptionalFile, resolveWorkspacePath } from "./_workspace.js";

type ManagedProcess = {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  logPath: string;
  child: ChildProcess;
};

const processes = new Map<string, ManagedProcess>();

export const manageProcessTool = defineTool({
  name: "manage_process",
  description: "Start, inspect, stop, or list background processes managed by the agent runtime.",
  inputSchema: s.object(
    {
      action: s.union([
        s.literal("start"),
        s.literal("status"),
        s.literal("stop"),
        s.literal("list"),
      ]),
      command: s.optional(s.string({ minLength: 1 })),
      processId: s.optional(s.string({ minLength: 1 })),
      cwd: s.optional(s.string({ minLength: 1 })),
    },
    { required: ["action"] },
  ),
  execute: async ({ action, command, processId, cwd }) => {
    switch (action) {
      case "start":
        if (!command) {
          throw new Error('command is required for action "start".');
        }
        return startProcess(command, cwd);
      case "status":
        if (!processId) {
          throw new Error('processId is required for action "status".');
        }
        return getProcessStatus(processId);
      case "stop":
        if (!processId) {
          throw new Error('processId is required for action "stop".');
        }
        return stopProcess(processId);
      case "list":
        return {
          processes: [...processes.values()].map(serializeProcess),
        };
    }
  },
}) satisfies ToolSpec;

async function startProcess(command: string, cwd?: string): Promise<Record<string, unknown>> {
  const workdir = cwd ? resolveWorkspacePath(cwd) : getWorkspaceRoot();
  const logDirectory = await createProcessLogDirectory();
  const logPath = path.join(logDirectory, "output.log");
  await writeFile(logPath, "", "utf8");
  const child = spawn(command, {
    cwd: workdir,
    shell: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processId = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const managed: ManagedProcess = {
    id: processId,
    command,
    cwd: workdir,
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    logPath,
    child,
  };

  processes.set(processId, managed);

  child.stdout?.on("data", (chunk) => appendLog(logPath, chunk));
  child.stderr?.on("data", (chunk) => appendLog(logPath, chunk));
  child.on("exit", (exitCode) => {
    managed.status = "exited";
    managed.exitCode = exitCode;
  });

  return serializeProcess(managed);
}

async function getProcessStatus(processId: string): Promise<Record<string, unknown>> {
  const processInfo = processes.get(processId);
  if (!processInfo) {
    throw new Error(`Unknown processId "${processId}".`);
  }

  return {
    ...serializeProcess(processInfo),
    output: await readOptionalFile(processInfo.logPath),
  };
}

async function stopProcess(processId: string): Promise<Record<string, unknown>> {
  const processInfo = processes.get(processId);
  if (!processInfo) {
    throw new Error(`Unknown processId "${processId}".`);
  }

  if (processInfo.status === "running" && processInfo.child.pid) {
    processInfo.child.kill("SIGTERM");
  }

  return {
    ...serializeProcess(processInfo),
    stopping: true,
  };
}

function serializeProcess(processInfo: ManagedProcess): Record<string, unknown> {
  return {
    processId: processInfo.id,
    command: processInfo.command,
    cwd: processInfo.cwd,
    pid: processInfo.pid,
    startedAt: processInfo.startedAt,
    status: processInfo.status,
    exitCode: processInfo.exitCode,
    logPath: processInfo.logPath,
  };
}

async function appendLog(logPath: string, chunk: unknown): Promise<void> {
  const content = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  await appendFile(logPath, content, "utf8");
}
