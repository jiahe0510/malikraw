import * as Lark from "@larksuiteoapi/node-sdk";

import type { StoredFeishuChannelConfig } from "../core/config/config-store.js";
import { defineTool, s, type ToolSpec } from "../core/tool-registry/index.js";

type ResolvedFeishuDocTarget = {
  sourceUrl: string;
  kind: "docx" | "wiki";
  token: string;
};

export function createReadFeishuDocTool(config: StoredFeishuChannelConfig) {
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
  });

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
      const target = parseFeishuDocUrl(url);

      if (target.kind === "docx") {
        const doc = await readDocx(client, target.token);
        return {
          url,
          sourceType: "docx",
          ...doc,
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
          url,
          sourceType: "wiki",
          wiki: {
            title: node.data?.node?.title,
            objType: resolvedType,
            objToken: resolvedToken,
          },
          unsupported: true,
          note: `This wiki link points to a ${resolvedType} object. Only docx documents are supported right now.`,
        };
      }

      const doc = await readDocx(client, resolvedToken);
      return {
        url,
        sourceType: "wiki",
        wiki: {
          title: node.data?.node?.title,
          objType: resolvedType,
          objToken: resolvedToken,
        },
        ...doc,
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

async function readDocx(client: Lark.Client, docToken: string) {
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
