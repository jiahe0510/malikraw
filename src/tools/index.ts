import type { ToolRegistry } from "../core/tool-registry/index.js";
import { lookupServiceStatusTool } from "./lookup-service-status.js";
import { summarizeNoteChunkTool } from "./summarize-note-chunk.js";

export const builtinTools = [
  lookupServiceStatusTool,
  summarizeNoteChunkTool,
];

export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of builtinTools) {
    registry.register(tool);
  }

  return registry;
}
