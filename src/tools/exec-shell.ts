import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { getWorkspaceRoot, resolveWorkspacePath } from "./_workspace.js";

const exec = promisify(execCallback);

export const execShellTool = defineTool({
  name: "exec_shell",
  description: "Run a shell command in the workspace and capture stdout, stderr, and exit status.",
  inputSchema: s.object(
    {
      command: s.string({ minLength: 1 }),
      cwd: s.optional(s.string({ minLength: 1 })),
      timeoutMs: s.optional(s.number({ integer: true, min: 1, max: 120000 })),
    },
    { required: ["command"] },
  ),
  execute: async ({ command, cwd, timeoutMs }) => {
    const workdir = cwd ? resolveWorkspacePath(cwd) : getWorkspaceRoot();
    const { stdout, stderr } = await exec(command, {
      cwd: workdir,
      timeout: timeoutMs ?? 30000,
      maxBuffer: 1024 * 1024,
    });

    return {
      command,
      cwd: workdir,
      stdout,
      stderr,
      exitCode: 0,
    };
  },
}) satisfies ToolSpec;
