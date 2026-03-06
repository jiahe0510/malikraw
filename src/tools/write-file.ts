import { writeFile } from "node:fs/promises";

import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { ensureParentDirectory, resolveWorkspacePath } from "./_workspace.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write UTF-8 text content to a workspace file, replacing any existing content.",
  inputSchema: s.object(
    {
      path: s.string({ minLength: 1 }),
      content: s.string(),
    },
    { required: ["path", "content"] },
  ),
  execute: async ({ path, content }) => {
    const absolutePath = resolveWorkspacePath(path);
    await ensureParentDirectory(absolutePath);
    await writeFile(absolutePath, content, "utf8");

    return {
      path,
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  },
}) satisfies ToolSpec;
