import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ToolRegistry,
  registerBuiltinTools,
  clearWorkspaceRoot,
  setWorkspaceRoot,
} from "../index.js";

test("read/write/edit tools operate on workspace files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-core-workspace-"));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  setWorkspaceRoot(workspace);

  try {
    const registry = registerBuiltinTools(new ToolRegistry());

    const writeResult = await registry.execute("write_file", {
      path: "notes/todo.txt",
      content: "hello world",
    });
    assert.equal(writeResult.ok, true);

    const editResult = await registry.execute("edit_file", {
      path: "notes/todo.txt",
      oldText: "world",
      newText: "agent",
    });
    assert.equal(editResult.ok, true);

    const readResult = await registry.execute("read_file", {
      path: "notes/todo.txt",
    });
    assert.equal(readResult.ok, true);
    if (readResult.ok) {
      const data = readResult.data as { content: string };
      assert.equal(data.content, "hello agent");
    }
  } finally {
    clearWorkspaceRoot();
    process.chdir(previousCwd);
  }
});

test("exec_shell captures stdout from workspace command", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-core-workspace-"));
  setWorkspaceRoot(workspace);
  const registry = registerBuiltinTools(new ToolRegistry());
  try {
    const result = await registry.execute("exec_shell", {
      command: "printf 'ok'",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { stdout: string };
      assert.equal(data.stdout, "ok");
    }
  } finally {
    clearWorkspaceRoot();
  }
});

test("manage_process can start, inspect, and stop a background process", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-core-workspace-"));
  setWorkspaceRoot(workspace);
  const registry = registerBuiltinTools(new ToolRegistry());
  try {
    const startResult = await registry.execute("manage_process", {
      action: "start",
      command: "node -e \"setTimeout(() => console.log('done'), 50)\"",
    });
    assert.equal(startResult.ok, true);
    if (!startResult.ok) {
      return;
    }

    const processData = startResult.data as { processId: string };
    const processId = processData.processId;
    assert.ok(processId);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const statusResult = await registry.execute("manage_process", {
      action: "status",
      processId,
    });
    assert.equal(statusResult.ok, true);
    if (statusResult.ok) {
      const data = statusResult.data as { logPath: string };
      const logPath = data.logPath;
      const log = await readFile(logPath, "utf8");
      assert.match(log, /done/);
    }

    const stopResult = await registry.execute("manage_process", {
      action: "stop",
      processId,
    });
    assert.equal(stopResult.ok, true);
  } finally {
    clearWorkspaceRoot();
  }
});
