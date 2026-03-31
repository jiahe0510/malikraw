import * as Lark from "@larksuiteoapi/node-sdk";

import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";

type ResolvedFeishuDocTarget = {
  sourceUrl: string;
  kind: "docx" | "wiki";
  token: string;
};

type ResolvedFeishuDocxTarget = {
  sourceUrl: string;
  sourceType: "docx" | "wiki";
  docToken: string;
  wikiTitle?: string;
};

type FeishuDocClient = Pick<Lark.Client, "docx" | "wiki">;

type ConvertedDocxPayload = Awaited<ReturnType<Lark.Client["docx"]["document"]["convert"]>>;
type ConvertedDocxBlock = NonNullable<NonNullable<ConvertedDocxPayload["data"]>["blocks"]>[number];
type DocxDescendantCreatePayload = NonNullable<
  Parameters<Lark.Client["docx"]["documentBlockDescendant"]["create"]>[0]
>;
type DocxDescendantBlock = NonNullable<
  NonNullable<DocxDescendantCreatePayload["data"]>["descendants"]
>[number];

export function createReadFeishuDocTool(
  config: StoredFeishuChannelConfig,
  client: FeishuDocClient = createFeishuDocClient(config),
) {

  return defineTool({
    name: "read_feishu_doc",
    description: "Read a Feishu docx or wiki document from a Feishu URL using the configured Feishu app credentials.",
    inputSchema: s.object(
      {
        url: s.string({ minLength: 1, maxLength: 2000 }),
      },
      { required: ["url"] },
    ),
    execute: async ({ url }) => {
      const resolved = await resolveDocxTarget(client, url);
      if ("unsupported" in resolved) {
        return {
          url,
          sourceType: "wiki",
          wiki: resolved.wiki,
          unsupported: true,
          note: resolved.note,
        };
      }
      const doc = await readDocx(client, resolved.docToken);
      return {
        url,
        sourceType: resolved.sourceType,
        ...(resolved.sourceType === "wiki"
          ? {
            wiki: {
              title: resolved.wikiTitle,
              objType: "docx",
              objToken: resolved.docToken,
            },
          }
          : {}),
        ...doc,
      };
    },
  }) satisfies ToolSpec;
}

export function createUpdateFeishuDocTool(
  config: StoredFeishuChannelConfig,
  client: FeishuDocClient = createFeishuDocClient(config),
) {
  return defineTool({
    name: "update_feishu_doc",
    description: "Update a Feishu docx document from a Feishu docx or wiki URL. Supports replacing or appending markdown content.",
    inputSchema: s.object(
      {
        url: s.string({ minLength: 1, maxLength: 2000 }),
        content: s.string({ minLength: 0, maxLength: 100000 }),
        mode: s.optional(s.union([s.literal("replace"), s.literal("append")])),
      },
      { required: ["url", "content"] },
    ),
    execute: async ({ url, content, mode }) => {
      const resolved = await resolveDocxTarget(client, url);
      if ("unsupported" in resolved) {
        throw new Error(resolved.note);
      }

      const normalizedMode = mode ?? "replace";
      const markdown = content.trim();
      let clearedBlocks = 0;

      if (normalizedMode === "replace") {
        clearedBlocks = await clearDocxDocument(client, resolved.docToken);
      }

      if (!markdown) {
        return {
          url,
          sourceType: resolved.sourceType,
          docToken: resolved.docToken,
          mode: normalizedMode,
          clearedBlocks,
          insertedBlocks: 0,
          note: normalizedMode === "replace"
            ? "Document content was cleared."
            : "Empty content provided. Nothing was appended.",
        };
      }

      const converted = await convertMarkdown(client, markdown);
      const normalized = normalizeConvertedBlockTree(
        converted.data?.blocks ?? [],
        converted.data?.first_level_block_ids ?? [],
      );
      await insertDocxBlocks(client, resolved.docToken, normalized.orderedBlocks, normalized.rootIds);

      return {
        url,
        sourceType: resolved.sourceType,
        docToken: resolved.docToken,
        mode: normalizedMode,
        clearedBlocks,
        insertedBlocks: normalized.rootIds.length,
      };
    },
  }) satisfies ToolSpec;
}

export function parseFeishuDocUrl(url: string): ResolvedFeishuDocTarget {
  const parsed = new URL(url);
  const docxMatch = parsed.pathname.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch?.[1]) {
    return {
      sourceUrl: url,
      kind: "docx",
      token: docxMatch[1],
    };
  }

  const wikiMatch = parsed.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch?.[1]) {
    return {
      sourceUrl: url,
      kind: "wiki",
      token: wikiMatch[1],
    };
  }

  throw new Error("Unsupported Feishu URL. Expected /docx/<token> or /wiki/<token>.");
}

async function readDocx(client: FeishuDocClient, docToken: string) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) {
    throw new Error(contentRes.msg || "Failed to read Feishu doc raw content");
  }
  if (infoRes.code !== 0) {
    throw new Error(infoRes.msg || "Failed to read Feishu doc info");
  }
  if (blocksRes.code !== 0) {
    throw new Error(blocksRes.msg || "Failed to read Feishu doc blocks");
  }

  const blocks = blocksRes.data?.items ?? [];

  return {
    title: infoRes.data?.document?.title,
    content: contentRes.data?.content ?? "",
    revisionId: infoRes.data?.document?.revision_id,
    blockCount: blocks.length,
  };
}

function createFeishuDocClient(config: StoredFeishuChannelConfig): FeishuDocClient {
  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
  });
}

async function resolveDocxTarget(client: FeishuDocClient, url: string): Promise<
  | ResolvedFeishuDocxTarget
  | {
      unsupported: true;
      wiki: {
        title?: string;
        objType: string;
        objToken: string;
      };
      note: string;
    }
> {
  const target = parseFeishuDocUrl(url);
  if (target.kind === "docx") {
    return {
      sourceUrl: url,
      sourceType: "docx",
      docToken: target.token,
    };
  }

  const node = await client.wiki.space.getNode({
    params: { token: target.token },
  });
  if (node.code !== 0) {
    throw new Error(node.msg || "Failed to resolve Feishu wiki node");
  }

  const resolvedType = node.data?.node?.obj_type;
  const resolvedToken = node.data?.node?.obj_token;
  if (!resolvedType || !resolvedToken) {
    throw new Error("Feishu wiki node did not return an object token");
  }

  if (resolvedType !== "docx") {
    return {
      unsupported: true,
      wiki: {
        title: node.data?.node?.title,
        objType: resolvedType,
        objToken: resolvedToken,
      },
      note: `This wiki link points to a ${resolvedType} object. Only docx documents are supported right now.`,
    };
  }

  return {
    sourceUrl: url,
    sourceType: "wiki",
    docToken: resolvedToken,
    wikiTitle: node.data?.node?.title,
  };
}

async function convertMarkdown(client: FeishuDocClient, markdown: string) {
  const response = await client.docx.document.convert({
    data: {
      content_type: "markdown",
      content: markdown,
    },
  });
  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to convert markdown for Feishu docx");
  }
  return response;
}

function normalizeConvertedBlockTree(
  blocks: ConvertedDocxBlock[],
  firstLevelIds: string[],
): { orderedBlocks: ConvertedDocxBlock[]; rootIds: string[] } {
  if (blocks.length <= 1) {
    const rootIds = blocks.length === 1 && typeof blocks[0]?.block_id === "string" ? [blocks[0].block_id] : [];
    return { orderedBlocks: blocks, rootIds };
  }

  const byId = new Map<string, ConvertedDocxBlock>();
  const originalOrder = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    if (typeof block?.block_id === "string") {
      byId.set(block.block_id, block);
      originalOrder.set(block.block_id, index);
    }
  }

  const childIds = new Set<string>();
  for (const block of blocks) {
    for (const childId of normalizeChildIds(block?.children)) {
      childIds.add(childId);
    }
  }

  const inferredTopLevelIds = blocks
    .filter((block) => {
      const blockId = block?.block_id;
      if (typeof blockId !== "string") {
        return false;
      }
      const parentId = typeof block?.parent_id === "string" ? block.parent_id : "";
      return !childIds.has(blockId) && (!parentId || !byId.has(parentId));
    })
    .sort(
      (a, b) =>
        (originalOrder.get(a.block_id ?? "__missing__") ?? 0) -
        (originalOrder.get(b.block_id ?? "__missing__") ?? 0),
    )
    .map((block) => block.block_id)
    .filter((blockId): blockId is string => typeof blockId === "string");

  const rootIds = (firstLevelIds.length > 0 ? firstLevelIds : inferredTopLevelIds)
    .filter((id, index, array) => typeof id === "string" && byId.has(id) && array.indexOf(id) === index);

  const orderedBlocks: ConvertedDocxBlock[] = [];
  const visited = new Set<string>();

  const visit = (blockId: string) => {
    if (!byId.has(blockId) || visited.has(blockId)) {
      return;
    }
    visited.add(blockId);
    const block = byId.get(blockId);
    if (!block) {
      return;
    }
    orderedBlocks.push(block);
    for (const childId of normalizeChildIds(block.children)) {
      visit(childId);
    }
  };

  for (const rootId of rootIds) {
    visit(rootId);
  }

  for (const block of blocks) {
    if (typeof block?.block_id === "string") {
      visit(block.block_id);
    } else {
      orderedBlocks.push(block);
    }
  }

  return { orderedBlocks, rootIds };
}

function normalizeChildIds(children: unknown): string[] {
  if (Array.isArray(children)) {
    return children.filter((child): child is string => typeof child === "string");
  }
  if (typeof children === "string") {
    return [children];
  }
  return [];
}

async function clearDocxDocument(client: FeishuDocClient, docToken: string): Promise<number> {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (existing.code !== 0) {
    throw new Error(existing.msg || "Failed to list Feishu doc blocks");
  }

  const rootChildren =
    existing.data?.items
      ?.filter((block) => block.parent_id === docToken && block.block_type !== 1)
      .map((block) => block.block_id)
      .filter((blockId): blockId is string => typeof blockId === "string") ?? [];

  if (rootChildren.length === 0) {
    return 0;
  }

  const response = await client.docx.documentBlockChildren.batchDelete({
    path: {
      document_id: docToken,
      block_id: docToken,
    },
    data: {
      start_index: 0,
      end_index: rootChildren.length,
    },
  });
  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to clear Feishu doc content");
  }

  return rootChildren.length;
}

async function insertDocxBlocks(
  client: FeishuDocClient,
  docToken: string,
  blocks: ConvertedDocxBlock[],
  rootIds: string[],
): Promise<void> {
  if (blocks.length === 0 || rootIds.length === 0) {
    return;
  }

  const response = await client.docx.documentBlockDescendant.create({
    path: {
      document_id: docToken,
      block_id: docToken,
    },
    data: {
      children_id: rootIds,
      descendants: blocks.map(toDescendantBlock),
      index: -1,
    },
  });
  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to insert Feishu doc content");
  }
}

function toDescendantBlock(block: ConvertedDocxBlock): DocxDescendantBlock {
  const children = normalizeChildIds(block.children);
  return {
    ...(block.block_id ? { block_id: block.block_id } : {}),
    ...(children.length > 0 ? { children } : {}),
    ...block,
  } as DocxDescendantBlock;
}
