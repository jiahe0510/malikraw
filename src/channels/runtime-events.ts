import type { AgentLoopEvent } from "../core/agent/types.js";

export function formatRuntimeEvent(event: AgentLoopEvent): string | undefined {
  switch (event.type) {
    case "prompt_ready":
      return `Preparing prompt and tools (${event.visibleToolNames.length} visible)`;
    case "assistant_message":
      return truncate(event.message.content, 160);
    case "tool_result":
      return event.result.ok
        ? `Tool ${event.result.toolName} finished`
        : `Tool ${event.result.toolName} failed: ${describeToolFailure(event.result.error)}`;
    case "reactive_compaction":
      return "Context was compacted to continue the turn";
    case "final_output":
      return undefined;
  }
}

function describeToolFailure(error: { message: string }): string {
  return truncate(error.message, 120);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
