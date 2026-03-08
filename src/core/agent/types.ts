import type { PromptRole, SelectedSkill } from "../skill-registry/types.js";
import type { ModelToolDefinition, ToolResultEnvelope } from "../tool-registry/types.js";

export type MessageRole = PromptRole | "user" | "assistant" | "tool";

export type AgentMessage = {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
};

export type AgentPromptInput = {
  globalPolicy: string;
  identitySystemContent?: string;
  personalitySystemContent?: string;
  agentSystemContent?: string;
  memorySystemContent?: string;
  userRequest: string;
  activeSkills: SelectedSkill[];
  toolSummary: string;
  history?: AgentMessage[];
  stateSummary?: string;
  memorySummary?: string;
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

export type AgentLoopInput = {
  model: AgentModel;
  toolRegistry: {
    toModelTools(toolNames?: readonly string[]): ModelToolDefinition[];
    describeTools(toolNames?: readonly string[]): string;
    has(toolName: string): boolean;
    execute(toolName: string, rawInput: unknown): Promise<ToolResultEnvelope>;
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
  maxIterations?: number;
  debugModelMessages?: boolean;
  authorizeTool?: ToolAuthorizationPolicy;
};

export type AgentLoopResult = {
  finalOutput: string;
  activeSkillIds: string[];
  messages: AgentMessage[];
  toolResults: ToolResultEnvelope[];
  visibleToolNames: string[];
};
