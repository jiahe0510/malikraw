import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";
import type { MemoryContext, MemoryService } from "../memory/types.js";

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
      },
      { required: ["query"] },
    ),
    execute: async ({ query }) => {
      const result = await memoryService.retrieve({
        context,
        query,
      });

      return {
        query,
        memoryItems: result.memoryItems.map((item) => ({
          query: item.query,
          summary: item.summary,
          content: item.content,
          importance: item.importance,
          source: item.source,
        })),
        toolChains: result.toolChains.map((item) => ({
          query: item.query,
          assistantResponse: item.assistantResponse,
          toolNames: item.toolChain.map((step) => step.toolName),
        })),
        sessionState: result.sessionState
          ? {
            goal: result.sessionState.state.taskState.goal,
            currentPlan: result.sessionState.state.taskState.currentPlan,
            completedSteps: result.sessionState.state.taskState.completedSteps,
            openQuestions: result.sessionState.state.taskState.openQuestions,
            status: result.sessionState.state.taskState.status,
          }
          : undefined,
        compiledBlock: result.compiledBlock,
        observations: {
          memoryItemsRetrieved: result.observations.memoryItemsRetrieved,
          toolChainsRetrieved: result.observations.toolChainsRetrieved,
          compiledChars: result.observations.compiledChars,
          estimatedTokens: result.observations.estimatedTokens,
        },
      };
    },
  }) satisfies ToolSpec;
}
