import { collectQueryContext, finalizeQueryContext, getVisibleToolNames } from "./build-prompt.js";
import { executeToolCalls } from "../tool-registry/tool-orchestrator.js";
import type {
  AgentLoopEvent,
  AgentLoopInput,
  AgentLoopResult,
  AgentMessage,
} from "./types.js";

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const events: AgentLoopEvent[] = [];
  const stream = runAgentLoopEvents(input);

  while (true) {
    const next = await stream.next();
    if (next.done) {
      return {
        ...next.value,
        events,
      };
    }

    events.push(next.value);
  }
}

export async function* runAgentLoopEvents(
  input: AgentLoopInput,
): AsyncGenerator<AgentLoopEvent, Omit<AgentLoopResult, "events">, void> {
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

  const queryContext = collectQueryContext({
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
    userContext: input.userContext,
    systemContext: input.systemContext,
  });
  const prompt = finalizeQueryContext(queryContext);

  yield {
    type: "prompt_ready",
    queryContext,
    prompt,
    visibleToolNames,
  };

  const messages: AgentMessage[] = [...prompt.messages];
  const toolResults = [];
  const maxIterations = input.maxIterations;
  let reactiveCompactions = 0;

  for (let iteration = 0; ; iteration += 1) {
    if (maxIterations !== undefined && iteration >= maxIterations) {
      throw new Error(`Agent loop exceeded maxIterations=${maxIterations}.`);
    }

    let modelResponse;
    try {
      modelResponse = await input.model.generate({
        messages,
        tools: input.toolRegistry.toModelTools(visibleToolNames),
        debug: input.debugModelMessages,
      });
    } catch (error) {
      const compactedMessages = await tryReactiveCompact(
        input,
        messages,
        error,
        iteration,
        reactiveCompactions,
      );
      if (!compactedMessages) {
        throw error;
      }

      reactiveCompactions += 1;
      messages.splice(0, messages.length, ...compactedMessages);
      yield {
        type: "reactive_compaction",
        iteration,
        messages: [...messages],
      };
      continue;
    }

    if (modelResponse.type === "final") {
      const assistantMessage: AgentMessage = {
        role: "assistant",
        content: modelResponse.outputText,
      };
      messages.push(assistantMessage);
      yield {
        type: "final_output",
        iteration,
        message: assistantMessage,
        output: modelResponse.outputText,
      };

      return {
        finalOutput: modelResponse.outputText,
        activeSkillIds: prompt.activeSkillIds,
        messages,
        toolResults,
        visibleToolNames,
      };
    }

    if (modelResponse.assistantMessage) {
      const assistantMessage: AgentMessage = {
        role: "assistant",
        content: modelResponse.assistantMessage,
      };
      messages.push(assistantMessage);
      yield {
        type: "assistant_message",
        iteration,
        message: assistantMessage,
      };
    }

    const executions = await executeToolCalls({
      toolCalls: modelResponse.toolCalls,
      visibleToolNames,
      messages,
      activeSkills: selected.skills,
      toolRegistry: input.toolRegistry,
      authorizeTool: input.authorizeTool,
    });
    for (const execution of executions) {
      toolResults.push(execution.result);
      messages.push(execution.message);
      yield {
        type: "tool_result",
        iteration,
        message: execution.message,
        result: execution.result,
      };
    }
  }
}

async function tryReactiveCompact(
  input: AgentLoopInput,
  messages: AgentMessage[],
  error: unknown,
  iteration: number,
  attempts: number,
): Promise<AgentMessage[] | undefined> {
  if (!input.reactiveCompact || attempts >= 2 || !isContextLengthError(error)) {
    return undefined;
  }

  return input.reactiveCompact({
    messages: [...messages],
    error,
    iteration,
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

function isContextLengthError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  if (record.contextLengthExceeded === true) {
    return true;
  }

  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return [
    "maximum context length",
    "context length exceeded",
    "prompt is too long",
    "too many tokens",
    "context window",
  ].some((pattern) => message.includes(pattern));
}
