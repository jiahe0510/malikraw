import type { AgentMessage } from "../agent/types.js";
import { getMessageText } from "../agent/message-content.js";

export type ProviderProfile = "openai" | "deepseek" | "qwen";

export type TransportContentPart = {
  type: "text";
  text: string;
};

export type TransportMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | TransportContentPart[];
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
  const instructionParts: TransportContentPart[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      instructionParts.push(...toTransportContentParts(message));
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
  const content = toTransportContent(message);
  if (!hasTransportContent(content)) {
    return undefined;
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: transportContentToString(content),
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
  instructionParts: TransportContentPart[],
): void {
  if (instructionParts.length === 0) {
    return;
  }

  normalized.push({
    role: "system",
    content: [...instructionParts],
  });
  instructionParts.length = 0;
}

function toTransportContent(message: AgentMessage): string | TransportContentPart[] {
  const parts = toTransportContentParts(message);
  if (parts.length === 0) {
    return "";
  }

  return parts.length === 1 ? parts[0]!.text : parts;
}

function toTransportContentParts(message: AgentMessage): TransportContentPart[] {
  if (!message.contentBlocks || message.contentBlocks.length === 0) {
    const content = getMessageText(message).trim();
    return content ? [{ type: "text", text: content }] : [];
  }

  return message.contentBlocks
    .map((block) => {
      if (block.type === "text") {
        const text = block.text.trim();
        return text ? { type: "text" as const, text } : undefined;
      }

      const text = (block.text ?? safeJsonStringify(block.data)).trim();
      return text ? { type: "text" as const, text } : undefined;
    })
    .filter((part): part is TransportContentPart => Boolean(part));
}

function hasTransportContent(content: string | TransportContentPart[]): boolean {
  return typeof content === "string" ? content.trim().length > 0 : content.length > 0;
}

function transportContentToString(content: string | TransportContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text).join("\n\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
