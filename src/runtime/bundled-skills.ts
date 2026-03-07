import { cp, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function getBundledSkillsDirectory(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}

export async function listBundledSkillIds(): Promise<string[]> {
  const entries = await readdir(getBundledSkillsDirectory(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function installBundledSkills(skillIds: readonly string[], workspaceRoot: string): Promise<void> {
  const targetRoot = path.join(workspaceRoot, "skills");
  await mkdir(targetRoot, { recursive: true });

  for (const skillId of skillIds) {
    const sourceDirectory = path.join(getBundledSkillsDirectory(), skillId);
    const targetDirectory = path.join(targetRoot, skillId);
    await cp(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}
