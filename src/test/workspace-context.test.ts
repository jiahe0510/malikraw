import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearWorkspaceRoot,
  ensureWorkspaceInitialized,
  getWorkspaceAgentFilePath,
  getWorkspaceIdentityFilePath,
  getWorkspaceMemoryFilePath,
  getWorkspacePersonalityFilePath,
  readWorkspaceAgentFile,
  readWorkspaceIdentityFile,
  readWorkspaceMemoryFile,
  readWorkspacePersonalityFile,
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
    assert.match(content ?? "", /# AGENT\.md/);
    assert.match(content ?? "", /This Agent exists to stay close to the user/);
  } finally {
    clearWorkspaceRoot();
  }
});

test("workspace initialization seeds PERSONALITY.md", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-workspace-"));
  setWorkspaceRoot(workspace);

  try {
    await ensureWorkspaceInitialized();

    const fileInfo = await stat(getWorkspacePersonalityFilePath());
    assert.equal(fileInfo.isFile(), true);

    const content = await readWorkspacePersonalityFile();
    assert.match(content ?? "", /# PERSONALITY\.md/);
    assert.match(content ?? "", /Malikraw should feel warm, alive, and close to the user/);
  } finally {
    clearWorkspaceRoot();
  }
});

test("workspace initialization seeds IDENTITY.md", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-workspace-"));
  setWorkspaceRoot(workspace);

  try {
    await ensureWorkspaceInitialized();

    const fileInfo = await stat(getWorkspaceIdentityFilePath());
    assert.equal(fileInfo.isFile(), true);

    const content = await readWorkspaceIdentityFile();
    assert.match(content ?? "", /Malikraw Identity/);
    assert.match(content ?? "", /## Who You Are/);
  } finally {
    clearWorkspaceRoot();
  }
});

test("workspace initialization seeds MEMORY.md", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-workspace-"));
  setWorkspaceRoot(workspace);

  try {
    await ensureWorkspaceInitialized();

    const fileInfo = await stat(getWorkspaceMemoryFilePath());
    assert.equal(fileInfo.isFile(), true);

    const content = await readWorkspaceMemoryFile();
    assert.match(content ?? "", /# MEMORY\.md/);
    assert.match(content ?? "", /durable user-specific memory/);
    assert.match(content ?? "", /workspace file tools/);
  } finally {
    clearWorkspaceRoot();
  }
});

test("workspace initialization does not auto-seed bundled skills", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-workspace-"));
  setWorkspaceRoot(workspace);

  try {
    await ensureWorkspaceInitialized();

    await assert.rejects(stat(path.join(workspace, "skills", "workspace_operator", "SKILL.md")));
  } finally {
    clearWorkspaceRoot();
  }
});
