import type { SelectedSkill } from "../skill-registry/types.js";
import { createJsonMessage } from "../agent/message-content.js";
import type {
  AgentMessage,
  ModelToolCall,
  ToolAuthorizationPolicy,
  ToolAuthorizationResult,
} from "../agent/types.js";
import type { ToolResultEnvelope } from "./types.js";

export type ToolCallExecution = {
  message: AgentMessage;
  result: ToolResultEnvelope;
};

export async function executeToolCalls(input: {
  toolCalls: readonly ModelToolCall[];
  visibleToolNames: readonly string[];
  messages: AgentMessage[];
  activeSkills: SelectedSkill[];
  toolRegistry: {
    has(toolName: string): boolean;
    execute(toolName: string, rawInput: unknown): Promise<ToolResultEnvelope>;
  };
  authorizeTool?: ToolAuthorizationPolicy;
}): Promise<ToolCallExecution[]> {
  const executions: ToolCallExecution[] = [];

  for (const toolCall of input.toolCalls) {
    if (!input.visibleToolNames.includes(toolCall.name) || !input.toolRegistry.has(toolCall.name)) {
      const result = authorizationFailure(
        toolCall.name,
        toolCall.id,
        `Tool "${toolCall.name}" is not visible for the active skills.`,
        "visibility",
      );
      executions.push({
        result,
        message: buildToolMessage(toolCall.id, toolCall.name, result),
      });
      continue;
    }

    const authorization = await authorize(input.authorizeTool, {
      toolName: toolCall.name,
      input: toolCall.input,
      messages: input.messages,
      activeSkills: input.activeSkills,
    });
    if (!authorization.ok) {
      const result = authorizationFailure(toolCall.name, toolCall.id, authorization.reason, "auth");
      executions.push({
        result,
        message: buildToolMessage(toolCall.id, toolCall.name, result),
      });
      continue;
    }

    const result = await input.toolRegistry.execute(toolCall.name, toolCall.input);
    executions.push({
      result,
      message: buildToolMessage(toolCall.id, toolCall.name, result),
    });
  }

  return executions;
}

async function authorize(
  policy: ToolAuthorizationPolicy | undefined,
  context: Parameters<ToolAuthorizationPolicy>[0],
): Promise<ToolAuthorizationResult> {
  if (!policy) {
    return { ok: true };
  }

  return policy(context);
}

function authorizationFailure(
  toolName: string,
  toolCallId: string,
  reason: string,
  prefix: string,
): ToolResultEnvelope<never> {
  const startedAt = new Date().toISOString();
  return {
    toolName,
    traceId: `${prefix}_${Date.now()}_${toolCallId}`,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    ok: false,
    error: {
      type: "authorization_error",
      message: reason,
    },
  };
}

function buildToolMessage(
  toolCallId: string,
  toolName: string,
  result: ToolResultEnvelope,
): AgentMessage {
  return createJsonMessage("tool", result, {
    toolCallId,
    toolName,
  });
}
