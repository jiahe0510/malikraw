import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import { classifyMemoryUsageTier } from "../memory/memory-compiler.js";
import type { MemoryContext, MemoryRetrieveMode, MemoryService } from "../memory/types.js";

export function createMemorySearchTool(
  memoryService: MemoryService,
  context: MemoryContext,
) {
  return defineTool({
    name: "search_memory",
    description: "Search stored user memory and reusable tool chains when past context may help with the current request.",
    inputSchema: s.object(
      {
        query: s.string({ minLength: 1, maxLength: 400 }),
        mode: s.optional(s.union([s.literal("normal"), s.literal("analytic")])),
      },
      { required: ["query"] },
    ),
    execute: async ({ query, mode }) => {
      const result = await memoryService.retrieve({
        context,
        query,
        mode: normalizeMode(mode),
      });

      return {
        query,
        mode: result.mode,
        knowledgeArtifacts: result.knowledgeArtifacts.map((item) => ({
          query: item.query,
          summary: item.summary,
          content: item.content,
          memoryType: item.memoryType ?? "semantic",
          tier: classifyMemoryUsageTier(item, result.mode),
          importance: item.importance,
          source: item.source,
        })),
        proceduralArtifacts: result.proceduralArtifacts.map((item) => ({
          query: item.query,
          assistantResponse: item.assistantResponse,
          toolNames: item.toolChain.map((step) => step.toolName),
        })),
        sessionState: result.sessionState
          ? {
            handoff: result.sessionState.state.handoff,
            notes: result.sessionState.state.notes,
          }
          : undefined,
        compiledBlock: result.compiledBlock,
        observations: {
          knowledgeArtifactsRetrieved: result.observations.knowledgeArtifactsRetrieved,
          proceduralArtifactsRetrieved: result.observations.proceduralArtifactsRetrieved,
          compiledChars: result.observations.compiledChars,
          estimatedTokens: result.observations.estimatedTokens,
        },
      };
    },
  }) satisfies ToolSpec;
}

function normalizeMode(value: unknown): MemoryRetrieveMode | undefined {
  return value === "analytic" || value === "normal" ? value : undefined;
}
