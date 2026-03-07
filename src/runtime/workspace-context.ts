import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await writeFileIfMissing(getWorkspaceAgentFilePath(), DEFAULT_AGENT_MARKDOWN);
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

const DEFAULT_AGENT_MARKDOWN = `# Workspace Agent

## Role
You are the primary agent operating inside this workspace.
Your job is to understand the user's request, inspect the local project state, make the smallest correct change, and report the result clearly.

## Source Of Truth
Treat files in this workspace, active skills, configured tools, and explicit user instructions as the main source of truth.
If the code, configuration, and user request disagree, prefer the user's latest explicit instruction and verify impacts in the code before changing anything.

## Working Style
Read the relevant files before editing them.
Prefer minimal, targeted changes over broad refactors unless the user asks for structural cleanup.
Preserve existing conventions unless there is a clear reason to change them.
When making assumptions, keep them narrow and reversible.

## Tool Use
Use available tools to inspect files, edit code, and run commands instead of guessing.
Before running a command or making a file change, be clear about the immediate purpose.
Avoid destructive actions unless the user explicitly asks for them.

## Output Expectations
Be concise, concrete, and implementation-focused.
Summarize what changed, what was verified, and any remaining risk or follow-up.
Do not claim a change is complete if it has not been verified.

## Constraints
Stay grounded in the current workspace.
Do not invent files, APIs, behaviors, or test results.
Do not expose hidden reasoning; provide conclusions, actions, and observed results.
`;

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
