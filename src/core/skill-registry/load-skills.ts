import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PromptRole, SkillSpec } from "./types.js";

export async function loadSkillsFromDirectory(directoryPath: string): Promise<SkillSpec[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const skills: SkillSpec[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = path.join(directoryPath, entry.name, "SKILL.md");
    const raw = await readFile(skillPath, "utf8");
    skills.push(parseSkillMarkdown(raw, skillPath));
  }

  return skills;
}

export function parseSkillMarkdown(markdown: string, source = "SKILL.md"): SkillSpec {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith("---\n")) {
    throw new Error(`Skill file ${source} is missing frontmatter.`);
  }

  const endIndex = trimmed.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    throw new Error(`Skill file ${source} has an unterminated frontmatter block.`);
  }

  const frontmatter = trimmed.slice(4, endIndex);
  const body = trimmed.slice(endIndex + 5).trim();
  const metadata = parseFrontmatter(frontmatter, source);

  if (!metadata.name) {
    throw new Error(`Skill file ${source} is missing required field "name".`);
  }
  if (!metadata.description) {
    throw new Error(`Skill file ${source} is missing required field "description".`);
  }
  if (!body) {
    throw new Error(`Skill file ${source} must include instruction content after frontmatter.`);
  }

  return {
    name: metadata.name,
    description: metadata.description,
    promptRole: metadata.promptRole ?? "developer",
    instruction: body,
    metadata: buildSkillMetadata(metadata),
  };
}

type ParsedFrontmatter = {
  name?: string;
  description?: string;
  promptRole?: PromptRole;
  tags?: string[];
  version?: string;
  owner?: string;
  allowedTools?: string[];
  examples?: string[];
};

function parseFrontmatter(frontmatter: string, source: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};

  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`Invalid frontmatter line in ${source}: "${rawLine}"`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());

    switch (key) {
      case "name":
        result.name = value;
        break;
      case "description":
        result.description = value;
        break;
      case "promptRole":
        if (value !== "system" && value !== "developer") {
          throw new Error(`Invalid promptRole "${value}" in ${source}.`);
        }
        result.promptRole = value;
        break;
      case "tags":
        result.tags = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case "version":
        result.version = value;
        break;
      case "owner":
        result.owner = value;
        break;
      case "allowedTools":
        result.allowedTools = splitList(value);
        break;
      case "examples":
        result.examples = splitList(value);
        break;
      default:
        break;
    }
  }

  return result;
}

function buildSkillMetadata(metadata: ParsedFrontmatter): SkillSpec["metadata"] | undefined {
  if (!metadata.tags && !metadata.version && !metadata.owner && !metadata.allowedTools && !metadata.examples) {
    return undefined;
  }

  return {
    tags: metadata.tags,
    version: metadata.version,
    owner: metadata.owner,
    allowedTools: metadata.allowedTools,
    examples: metadata.examples,
  };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}
