import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

let workspaceRootOverride: string | undefined;

export function setWorkspaceRoot(workspaceRoot: string): void {
  workspaceRootOverride = workspaceRoot;
}

export function clearWorkspaceRoot(): void {
  workspaceRootOverride = undefined;
}

export function getWorkspaceRoot(): string {
  return workspaceRootOverride ?? path.join(homedir(), ".malikraw");
}

export function getSkillsDirectory(): string {
  return path.join(getWorkspaceRoot(), "skills");
}

export function getRuntimeDirectory(): string {
  return path.join(getWorkspaceRoot(), ".runtime");
}

export async function ensureWorkspaceInitialized(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(getSkillsDirectory(), { recursive: true });
  await mkdir(path.join(getRuntimeDirectory(), "processes"), { recursive: true });
  await seedDefaultSkill();
}

async function seedDefaultSkill(): Promise<void> {
  const directory = path.join(getSkillsDirectory(), "workspace_operator");
  const filePath = path.join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(filePath, DEFAULT_WORKSPACE_OPERATOR_SKILL, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code !== "EEXIST") {
      throw error;
    }
  }
}

const DEFAULT_WORKSPACE_OPERATOR_SKILL = `---
name: workspace_operator
description: Operate on workspace files, run shell commands, and manage background processes carefully.
promptRole: developer
tags: workspace, files, shell, process
version: 1
owner: agent-core
allowedTools: read_file, write_file, edit_file, exec_shell, manage_process
examples: Read files before editing them, Explain command risk before changing the workspace
---

Inspect the current workspace state before making changes.
Prefer the narrowest tool action that accomplishes the task.
Read files before overwriting or editing them unless the user explicitly asks for blind replacement.
When running commands, explain the purpose briefly and avoid speculative or destructive actions.
When managing background processes, report the process state, log location, and next control action clearly.
Do not reveal hidden chain-of-thought; provide decisions, actions, and observed results only.
`;
