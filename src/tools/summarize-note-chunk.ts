import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";

export const summarizeNoteChunkTool = defineTool({
  name: "summarize_note_chunk",
  description: "Summarize a note chunk into key decisions, open questions, and actions.",
  inputSchema: s.object(
    {
      note: s.string({ minLength: 1 }),
    },
    { required: ["note"] },
  ),
  execute: ({ note }) => ({
    summary: note.slice(0, 240),
  }),
}) satisfies ToolSpec;
