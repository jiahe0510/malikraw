import { buildPrompt, getVisibleToolNames } from "./build-prompt.js";
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

  const allToolNames = input.toolRegistry.toModelTools().map((tool) => tool.function.name);
  const visibleToolNames = getVisibleToolNames(selected.skills, allToolNames);

  const prompt = buildPrompt({
    globalPolicy: input.globalPolicy,
    identitySystemContent: input.identitySystemContent,
    personalitySystemContent: input.personalitySystemContent,
    agentSystemContent: input.agentSystemContent,
    memorySystemContent: input.memorySystemContent,
    userRequest: input.userRequest,
    activeSkills: selected.skills,
    toolSummary: input.toolRegistry.describeTools(visibleToolNames),
    history: input.history,
    stateSummary: input.stateSummary,
    memorySummary: input.memorySummary,
    relevantMemoryBlock: input.relevantMemoryBlock,
  });

  const messages: AgentMessage[] = [...prompt.messages];
  const toolResults = [];
  const maxIterations = input.maxIterations;

  for (let iteration = 0; ; iteration += 1) {
    if (maxIterations !== undefined && iteration >= maxIterations) {
      throw new Error(`Agent loop exceeded maxIterations=${maxIterations}.`);
    }

    const modelResponse = await input.model.generate({
      messages,
      tools: input.toolRegistry.toModelTools(visibleToolNames),
      debug: input.debugModelMessages,
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
        visibleToolNames,
      };
    }

    if (modelResponse.assistantMessage) {
      messages.push({
        role: "assistant",
        content: modelResponse.assistantMessage,
      });
    }

    for (const toolCall of modelResponse.toolCalls) {
      if (!visibleToolNames.includes(toolCall.name) || !input.toolRegistry.has(toolCall.name)) {
        const deniedResult = {
          toolName: toolCall.name,
          traceId: `visibility_${Date.now()}_${toolCall.id}`,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          ok: false as const,
          error: {
            type: "authorization_error" as const,
            message: `Tool "${toolCall.name}" is not visible for the active skills.`,
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
