import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
import {
  readDefaultAgentTemplateFile,
  readDefaultIdentityTemplateFile,
  readDefaultMemoryTemplateFile,
  readDefaultPersonalityTemplateFile,
} from "./system-template-context.js";

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

export function getWorkspacePersonalityFilePath(): string {
  return path.join(getWorkspaceRoot(), "PERSONALITY.md");
}

export function getWorkspaceIdentityFilePath(): string {
  return path.join(getWorkspaceRoot(), "IDENTITY.md");
}

export function getWorkspaceMemoryFilePath(): string {
  return path.join(getWorkspaceRoot(), "MEMORY.md");
}

export async function ensureWorkspaceInitialized(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(getSkillsDirectory(), { recursive: true });
  await mkdir(path.join(getRuntimeDirectory(), "processes"), { recursive: true });
  await seedWorkspaceIdentityFile();
  await seedWorkspacePersonalityFile();
  await seedWorkspaceAgentFile();
  await seedWorkspaceMemoryFile();
}

export async function readWorkspaceAgentFile(): Promise<string | undefined> {
  return readOptionalWorkspaceFile(getWorkspaceAgentFilePath());
}

export async function readWorkspacePersonalityFile(): Promise<string | undefined> {
  return readOptionalWorkspaceFile(getWorkspacePersonalityFilePath());
}

export async function readWorkspaceIdentityFile(): Promise<string | undefined> {
  return readOptionalWorkspaceFile(getWorkspaceIdentityFilePath());
}

export async function readWorkspaceMemoryFile(): Promise<string | undefined> {
  return readOptionalWorkspaceFile(getWorkspaceMemoryFilePath());
}

async function readOptionalWorkspaceFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
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

async function seedWorkspacePersonalityFile(): Promise<void> {
  const content = await readDefaultPersonalityTemplateFile();
  if (!content) {
    throw new Error("Default PERSONALITY.md template is empty.");
  }

  await writeFileIfMissing(getWorkspacePersonalityFilePath(), content);
}

async function seedWorkspaceIdentityFile(): Promise<void> {
  const content = await readDefaultIdentityTemplateFile();
  if (!content) {
    throw new Error("Default IDENTITY.md template is empty.");
  }

  await writeFileIfMissing(getWorkspaceIdentityFilePath(), content);
}

async function seedWorkspaceAgentFile(): Promise<void> {
  const content = await readDefaultAgentTemplateFile();
  if (!content) {
    throw new Error("Default AGENT.md template is empty.");
  }

  await writeFileIfMissing(getWorkspaceAgentFilePath(), content);
}

async function seedWorkspaceMemoryFile(): Promise<void> {
  const content = await readDefaultMemoryTemplateFile();
  if (!content) {
    throw new Error("Default MEMORY.md template is empty.");
  }

  await writeFileIfMissing(getWorkspaceMemoryFilePath(), content);
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
