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
  mergeInstructionMessages: boolean;
};

const PROFILES: Record<ProviderProfile, CompatibilityProfile> = {
  openai: {
    supportsDeveloperRole: true,
    mergeInstructionMessages: false,
  },
  deepseek: {
    supportsDeveloperRole: false,
    mergeInstructionMessages: true,
  },
  qwen: {
    supportsDeveloperRole: false,
    mergeInstructionMessages: true,
  },
};

export function normalizeMessagesForProfile(
  messages: readonly AgentMessage[],
  profile?: ProviderProfile,
): TransportMessage[] {
  const compatibility = PROFILES[profile ?? "openai"];

  if (!compatibility.mergeInstructionMessages && compatibility.supportsDeveloperRole) {
    return messages
      .map((message) => toTransportMessage(message, compatibility))
      .filter((message): message is TransportMessage => message !== undefined);
  }

  const normalized: TransportMessage[] = [];
  const instructionParts: string[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const content = message.content.trim();
      if (content) {
        instructionParts.push(content);
      }
      continue;
    }

    flushInstructionParts(normalized, instructionParts);
    const transport = toTransportMessage(message, compatibility);
    if (transport) {
      normalized.push(transport);
    }
  }

  flushInstructionParts(normalized, instructionParts);
  return normalized;
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

function flushInstructionParts(
  normalized: TransportMessage[],
  instructionParts: string[],
): void {
  if (instructionParts.length === 0) {
    return;
  }

  normalized.push({
    role: "system",
    content: instructionParts.join("\n\n"),
  });
  instructionParts.length = 0;
}
