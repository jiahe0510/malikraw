import { editFileTool } from "./edit-file.js";
import { execShellTool } from "./exec-shell.js";
import type { ToolRegistry } from "../core/tool-registry/index.js";
import { manageProcessTool } from "./process-manager.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";

export const builtinTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  execShellTool,
  manageProcessTool,
];

export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of builtinTools) {
    registry.register(tool);
  }

  return registry;
}
