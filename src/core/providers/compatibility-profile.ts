import type { AgentMessage } from "../agent/types.js";

export type ProviderProfile = "openai" | "deepseek" | "qwen";

export type TransportMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
};

type CompatibilityProfile = {
  supportsDeveloperRole: boolean;
};

const PROFILES: Record<ProviderProfile, CompatibilityProfile> = {
  openai: {
    supportsDeveloperRole: true,
  },
  deepseek: {
    supportsDeveloperRole: false,
  },
  qwen: {
    supportsDeveloperRole: false,
  },
};

export function normalizeMessagesForProfile(
  messages: readonly AgentMessage[],
  profile?: ProviderProfile,
): TransportMessage[] {
  const compatibility = PROFILES[profile ?? "openai"];
  return messages
    .map((message) => toTransportMessage(message, compatibility))
    .filter((message): message is TransportMessage => message !== undefined);
}

function toTransportMessage(
  message: AgentMessage,
  compatibility: CompatibilityProfile,
): TransportMessage | undefined {
  const content = message.content.trim();
  if (!content) {
    return undefined;
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content,
      tool_call_id: message.toolCallId,
      name: message.toolName,
    };
  }

  if (message.role === "developer" && !compatibility.supportsDeveloperRole) {
    return {
      role: "system",
      content,
    };
  }

  return {
    role: message.role,
    content,
  };
}
