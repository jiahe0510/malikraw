import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
import { readDefaultAgentTemplateFile } from "./system-template-context.js";

let workspaceRootOverride: string | undefined;

export function setWorkspaceRoot(workspaceRoot: string): void {
  workspaceRootOverride = workspaceRoot;
}

export function clearWorkspaceRoot(): void {
  workspaceRootOverride = undefined;
}

export function getWorkspaceRoot(): string {
  return workspaceRootOverride ?? path.join(getMalikrawHomeDirectory(), "workspace");
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
