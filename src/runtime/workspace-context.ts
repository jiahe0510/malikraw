import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readDefaultAgentTemplateFile } from "./system-template-context.js";

let workspaceRootOverride: string | undefined;

export function setWorkspaceRoot(workspaceRoot: string): void {
  workspaceRootOverride = workspaceRoot;
}

export function clearWorkspaceRoot(): void {
  workspaceRootOverride = undefined;
}

export function getWorkspaceRoot(): string {
  return workspaceRootOverride ?? path.join(homedir(), ".malikraw", "workspace");
}

export function getSkillsDirectory(): string {
  return path.join(getWorkspaceRoot(), "skills");
}

export function getRuntimeDirectory(): string {
  return path.join(getWorkspaceRoot(), ".runtime");
}

export function getWorkspaceAgentFilePath(): string {
  return path.join(getWorkspaceRoot(), "AGENT.md");
}

export async function ensureWorkspaceInitialized(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(getSkillsDirectory(), { recursive: true });
  await mkdir(path.join(getRuntimeDirectory(), "processes"), { recursive: true });
  await seedWorkspaceAgentFile();
  await seedDefaultSkill();
}

export async function readWorkspaceAgentFile(): Promise<string | undefined> {
  try {
    const content = await readFile(getWorkspaceAgentFilePath(), "utf8");
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function seedWorkspaceAgentFile(): Promise<void> {
  const content = await readDefaultAgentTemplateFile();
  if (!content) {
    throw new Error("Default AGENT.md template is empty.");
  }

  await writeFileIfMissing(getWorkspaceAgentFilePath(), content);
}

async function seedDefaultSkill(): Promise<void> {
  const directory = path.join(getSkillsDirectory(), "workspace_operator");
  const filePath = path.join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });

  await writeFileIfMissing(filePath, DEFAULT_WORKSPACE_OPERATOR_SKILL);
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, {
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
