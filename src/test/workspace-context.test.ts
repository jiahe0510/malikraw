import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearWorkspaceRoot,
  ensureWorkspaceInitialized,
  getWorkspaceAgentFilePath,
  readWorkspaceAgentFile,
  setWorkspaceRoot,
} from "../index.js";

test("workspace initialization seeds AGENT.md", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-workspace-"));
  setWorkspaceRoot(workspace);

  try {
    await ensureWorkspaceInitialized();

    const fileInfo = await stat(getWorkspaceAgentFilePath());
    assert.equal(fileInfo.isFile(), true);

    const content = await readWorkspaceAgentFile();
    assert.match(content ?? "", /Workspace Agent/);
    assert.match(content ?? "", /## Role/);
  } finally {
    clearWorkspaceRoot();
  }
});
