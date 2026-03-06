import { buildPrompt } from "./build-prompt.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentMessage,
  ToolAuthorizationResult,
} from "./types.js";

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const routeResult = await input.skillRouter.route({
    userRequest: input.userRequest,
    availableSkillIds: input.skillRegistry.list().map((skill) => skill.name),
    history: stringifyHistory(input.history),
    stateSummary: input.stateSummary,
  });

  const selected = input.skillRegistry.select(routeResult.activeSkillIds);
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }

  const prompt = buildPrompt({
    globalPolicy: input.globalPolicy,
    userRequest: input.userRequest,
    activeSkills: selected.skills,
    toolSummary: input.toolRegistry.describeTools(),
    history: input.history,
    stateSummary: input.stateSummary,
    memorySummary: input.memorySummary,
  });

  const messages: AgentMessage[] = [...prompt.messages];
  const toolResults = [];
  const maxIterations = input.maxIterations ?? 8;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const modelResponse = await input.model.generate({
      messages,
      tools: input.toolRegistry.toModelTools(),
    });

    if (modelResponse.type === "final") {
      messages.push({
        role: "assistant",
        content: modelResponse.outputText,
      });

      return {
        finalOutput: modelResponse.outputText,
        activeSkillIds: prompt.activeSkillIds,
        messages,
        toolResults,
      };
    }

    if (modelResponse.assistantMessage) {
      messages.push({
        role: "assistant",
        content: modelResponse.assistantMessage,
      });
    }

    for (const toolCall of modelResponse.toolCalls) {
      const authorization = await authorizeTool(input, messages, prompt.activeSkillIds, toolCall.name, toolCall.input, selected.skills);
      if (!authorization.ok) {
        const deniedResult = {
          toolName: toolCall.name,
          traceId: `auth_${Date.now()}_${toolCall.id}`,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          ok: false as const,
          error: {
            type: "authorization_error" as const,
            message: authorization.reason,
          },
        };

        toolResults.push(deniedResult);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify(deniedResult),
        });
        continue;
      }

      const result = await input.toolRegistry.execute(toolCall.name, toolCall.input);
      toolResults.push(result);
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error(`Agent loop exceeded maxIterations=${maxIterations}.`);
}

async function authorizeTool(
  input: AgentLoopInput,
  messages: AgentMessage[],
  _activeSkillIds: string[],
  toolName: string,
  toolInput: unknown,
  activeSkills: Parameters<NonNullable<AgentLoopInput["authorizeTool"]>>[0]["activeSkills"],
): Promise<ToolAuthorizationResult> {
  if (!input.authorizeTool) {
    return { ok: true };
  }

  return input.authorizeTool({
    toolName,
    input: toolInput,
    messages,
    activeSkills,
  });
}

function stringifyHistory(history: AgentMessage[] | undefined): string | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }

  return history
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}
