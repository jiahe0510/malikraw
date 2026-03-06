import { readFile, writeFile } from "node:fs/promises";

import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { resolveWorkspacePath } from "./_workspace.js";

export const editFileTool = defineTool({
  name: "edit_file",
  description: "Edit a workspace file by replacing an exact string match with new content.",
  inputSchema: s.object(
    {
      path: s.string({ minLength: 1 }),
      oldText: s.string(),
      newText: s.string(),
      replaceAll: s.optional(s.boolean()),
    },
    { required: ["path", "oldText", "newText"] },
  ),
  execute: async ({ path, oldText, newText, replaceAll }) => {
    const absolutePath = resolveWorkspacePath(path);
    const original = await readFile(absolutePath, "utf8");

    if (!oldText) {
      throw new Error("oldText must not be empty.");
    }
    if (!original.includes(oldText)) {
      throw new Error("oldText was not found in the target file.");
    }

    const occurrences = original.split(oldText).length - 1;
    const updated = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);

    await writeFile(absolutePath, updated, "utf8");

    return {
      path,
      replacements: replaceAll ? occurrences : 1,
    };
  },
}) satisfies ToolSpec;
