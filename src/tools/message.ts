import { stat } from "node:fs/promises";
import path from "node:path";

import { defineTool, s } from "../core/tool-registry/index.js";
import type { ChannelMedia, MessageDispatch } from "../channels/channel.js";
import { resolveWorkspacePath } from "./_workspace.js";

const messageMediaSchema = s.object({
  path: s.string({ minLength: 1 }),
  kind: s.optional(s.union([s.literal("image"), s.literal("file")])),
  fileName: s.optional(s.string({ minLength: 1 })),
  caption: s.optional(s.string({ minLength: 1 })),
}, {
  required: ["path"],
});

export const messageTool = defineTool({
  name: "message",
  description: "Send a structured message through the gateway to the current or target channel, optionally with media attachments.",
  inputSchema: s.object({
    content: s.optional(s.string()),
    channelId: s.optional(s.string({ minLength: 1 })),
    sessionId: s.optional(s.string({ minLength: 1 })),
    agentId: s.optional(s.string({ minLength: 1 })),
    userId: s.optional(s.string({ minLength: 1 })),
    projectId: s.optional(s.string({ minLength: 1 })),
    media: s.optional(s.array(messageMediaSchema)),
  }, {
    allowUnknownKeys: false,
  }),
  execute: async (input): Promise<MessageDispatch> => {
    const media = await normalizeMessageMedia(input.media ?? []);
    if (!input.content?.trim() && media.length === 0) {
      throw new Error('message tool requires "content" or at least one media item.');
    }

    const session = compactSessionOverrides({
      channelId: input.channelId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      userId: input.userId,
      projectId: input.projectId,
    });

    return {
      ...(session ? { session } : {}),
      content: input.content?.trim() ?? "",
      media,
    };
  },
});

async function normalizeMessageMedia(
  inputMedia: Array<{
    path: string;
    kind?: "image" | "file";
    fileName?: string;
    caption?: string;
  }>,
): Promise<ChannelMedia[]> {
  const media: ChannelMedia[] = [];

  for (const item of inputMedia) {
    const resolvedPath = resolveWorkspacePath(item.path);
    await assertReadableFile(resolvedPath);
    media.push({
      kind: item.kind ?? inferMediaKind(resolvedPath),
      path: resolvedPath,
      fileName: item.fileName?.trim() || path.basename(resolvedPath),
      ...(item.caption?.trim() ? { caption: item.caption.trim() } : {}),
    });
  }

  return media;
}

async function assertReadableFile(targetPath: string): Promise<void> {
  const details = await stat(targetPath);
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`Media path "${targetPath}" is not a readable non-empty file.`);
  }
}

function inferMediaKind(filePath: string): "image" | "file" {
  const extension = path.extname(filePath).toLowerCase();
  if ([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".tiff",
    ".bmp",
    ".ico",
  ].includes(extension)) {
    return "image";
  }

  return "file";
}

function compactSessionOverrides(session: MessageDispatch["session"]): MessageDispatch["session"] {
  if (!session) {
    return undefined;
  }

  const compacted = Object.fromEntries(
    Object.entries(session).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
