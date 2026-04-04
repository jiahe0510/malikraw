import type { PromptRole, SelectedSkill } from "../skill-registry/types.js";
import type { ModelToolDefinition, ToolResultEnvelope } from "../tool-registry/types.js";

export type MessageRole = PromptRole | "user" | "assistant" | "tool";

export type AgentContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "json";
      data: unknown;
      text?: string;
    };

export type AgentMessage = {
  role: MessageRole;
  content: string;
  contentBlocks?: AgentContentBlock[];
  toolCallId?: string;
  toolName?: string;
};

export type AgentPromptInput = {
  globalPolicy: string;
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  userContext?: Record<string, string | undefined>;
  systemContext?: Record<string, string | undefined>;
  userRequest: string;
  activeSkills: SelectedSkill[];
  toolSummary: string;
  history?: AgentMessage[];
  stateSummary?: string;
  memorySummary?: string;
  relevantMemoryBlock?: string;
};

export type QueryContext = {
  instructionMessages: Array<{
    role: PromptRole;
    content: string;
  }>;
  userContext: Record<string, string | undefined>;
  systemContext: Record<string, string | undefined>;
  memorySystemContent?: string;
  relevantMemoryBlock?: string;
  history: AgentMessage[];
  userRequest: string;
  activeSkillIds: string[];
};

export type BuiltPrompt = {
  messages: AgentMessage[];
  activeSkillIds: string[];
};

export type ModelToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ModelTurnResponse =
  | {
      type: "final";
      outputText: string;
    }
  | {
      type: "tool_calls";
      toolCalls: ModelToolCall[];
      assistantMessage?: string;
    };

export type AgentModelRequest = {
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  debug?: boolean;
  traceId?: string;
};

export interface AgentModel {
  generate(input: AgentModelRequest): Promise<ModelTurnResponse> | ModelTurnResponse;
}

export type ToolAuthorizationContext = {
  toolName: string;
  input: unknown;
  messages: AgentMessage[];
  activeSkills: SelectedSkill[];
};

export type ToolAuthorizationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ToolAuthorizationPolicy = (
  context: ToolAuthorizationContext,
) => Promise<ToolAuthorizationResult> | ToolAuthorizationResult;

export type ReactiveCompactionPolicy = (
  context: {
    messages: AgentMessage[];
    error: unknown;
    iteration: number;
  },
) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined;

export type AgentLoopInput = {
  traceId?: string;
  model: AgentModel;
  toolRegistry: {
    toModelTools(toolNames?: readonly string[]): ModelToolDefinition[];
    describeTools(toolNames?: readonly string[]): string;
    has(toolName: string): boolean;
    execute(toolName: string, rawInput: unknown, options?: { traceId?: string }): Promise<ToolResultEnvelope>;
  };
  skillRouter: {
    route(input: {
      userRequest: string;
      availableSkillIds: string[];
      history?: string;
      stateSummary?: string;
    }): Promise<{ activeSkillIds: string[] }> | { activeSkillIds: string[] };
  };
  skillRegistry: {
    list(): { name: string }[];
    select(skillNames: readonly string[]): { ok: true; skills: SelectedSkill[] } | { ok: false; error: { message: string } };
  };
  globalPolicy: string;
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  userRequest: string;
  history?: AgentMessage[];
  stateSummary?: string;
  memorySummary?: string;
  relevantMemoryBlock?: string;
  userContext?: Record<string, string | undefined>;
  systemContext?: Record<string, string | undefined>;
  maxIterations?: number;
  debugModelMessages?: boolean;
  authorizeTool?: ToolAuthorizationPolicy;
  reactiveCompact?: ReactiveCompactionPolicy;
};

export type AgentLoopEvent =
  | {
      type: "prompt_ready";
      queryContext: QueryContext;
      prompt: BuiltPrompt;
      visibleToolNames: string[];
    }
  | {
      type: "assistant_message";
      iteration: number;
      message: AgentMessage;
    }
  | {
      type: "tool_result";
      iteration: number;
      message: AgentMessage;
      result: ToolResultEnvelope;
    }
  | {
      type: "reactive_compaction";
      iteration: number;
      messages: AgentMessage[];
    }
  | {
      type: "final_output";
      iteration: number;
      message: AgentMessage;
      output: string;
    };

export type AgentLoopResult = {
  finalOutput: string;
  activeSkillIds: string[];
  messages: AgentMessage[];
  toolResults: ToolResultEnvelope[];
  visibleToolNames: string[];
  events: AgentLoopEvent[];
};
