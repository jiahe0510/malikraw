import { readFile, stat } from "node:fs/promises";

import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { resolveWorkspacePath } from "./_workspace.js";

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace.",
  inputSchema: s.object(
    {
      path: s.string({ minLength: 1 }),
    },
    { required: ["path"] },
  ),
  execute: async ({ path }) => {
    const absolutePath = resolveWorkspacePath(path);
    const fileStat = await stat(absolutePath);
    const content = await readFile(absolutePath, "utf8");

    return {
      path,
      sizeBytes: fileStat.size,
      content,
    };
  },
}) satisfies ToolSpec;
