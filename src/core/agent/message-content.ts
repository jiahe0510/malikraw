import type { AgentMessage, AgentContentBlock, MessageRole } from "./types.js";

export function createTextMessage(
  role: MessageRole,
  content: string,
  options: Pick<AgentMessage, "toolCallId" | "toolName"> = {},
): AgentMessage {
  return {
    role,
    content,
    contentBlocks: [{ type: "text", text: content }],
    ...options,
  };
}

export function createJsonMessage(
  role: MessageRole,
  data: unknown,
  options: Pick<AgentMessage, "toolCallId" | "toolName"> = {},
): AgentMessage {
  const content = stringifyJson(data);
  return {
    role,
    content,
    contentBlocks: [{
      type: "json",
      data,
      text: content,
    }],
    ...options,
  };
}

export function getMessageText(message: Pick<AgentMessage, "content" | "contentBlocks">): string {
  if (!message.contentBlocks || message.contentBlocks.length === 0) {
    return message.content;
  }

  return message.contentBlocks.map(renderBlockText).join("\n").trim();
}

export function withNormalizedContent(message: AgentMessage): AgentMessage {
  const content = getMessageText(message);
  const contentBlocks = message.contentBlocks ?? [{ type: "text", text: content } satisfies AgentContentBlock];
  return {
    ...message,
    content,
    contentBlocks,
  };
}

function renderBlockText(block: AgentContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }

  return block.text ?? stringifyJson(block.data);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
