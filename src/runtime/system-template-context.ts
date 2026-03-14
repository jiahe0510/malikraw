import { readFile } from "node:fs/promises";

function getTemplateFileUrl(fileName: string): URL {
  return new URL(`../../templates/system/${fileName}`, import.meta.url);
}

export async function readSystemTemplateFile(fileName: string): Promise<string | undefined> {
  const content = await readFile(getTemplateFileUrl(fileName), "utf8");
  const trimmed = content.trim();
  return trimmed ? trimmed : undefined;
}

export async function readBundledPersonalityFile(): Promise<string | undefined> {
  return readSystemTemplateFile("PERSONALITY.md");
}

export async function readDefaultAgentTemplateFile(): Promise<string | undefined> {
  return readSystemTemplateFile("AGENT.md");
}

export async function readDefaultPersonalityTemplateFile(): Promise<string | undefined> {
  return readSystemTemplateFile("PERSONALITY.md");
}

export async function readDefaultIdentityTemplateFile(): Promise<string | undefined> {
  return readSystemTemplateFile("IDENTITY.md");
}

export async function readDefaultMemoryTemplateFile(): Promise<string | undefined> {
  return readSystemTemplateFile("MEMORY.md");
}

export async function readCompactTemplateFile(): Promise<string | undefined> {
  return readSystemTemplateFile("compact.md");
}
