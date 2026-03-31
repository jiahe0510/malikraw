import { editFileTool } from "./edit-file.js";
import { execShellTool } from "./exec-shell.js";
import type { ToolRegistry } from "../core/tool-registry/index.js";
import { manageProcessTool } from "./process-manager.js";
import { messageTool } from "./message.js";
import { createReadFeishuDocTool, createUpdateFeishuDocTool } from "./read-feishu-doc.js";
import { readFileTool } from "./read-file.js";
import { readUrlTool } from "./read-url.js";
import { createMemorySearchTool } from "./search-memory.js";
import { webSearchTool } from "./web-search.js";
import { writeFileTool } from "./write-file.js";

export const builtinTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  execShellTool,
  manageProcessTool,
  messageTool,
  readUrlTool,
  webSearchTool,
];

export { createMemorySearchTool } from "./search-memory.js";
export { createReadFeishuDocTool, createUpdateFeishuDocTool } from "./read-feishu-doc.js";

export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of builtinTools) {
    registry.register(tool);
  }

  return registry;
}
