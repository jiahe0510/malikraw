import test from "node:test";
import assert from "node:assert/strict";

import { createUpdateFeishuDocTool, parseFeishuDocUrl } from "../tools/read-feishu-doc.js";
import { extractTextFromHtml, normalizeUrlContent, readUrlTool } from "../tools/read-url.js";

test("extractTextFromHtml removes scripts and keeps visible text", () => {
  const text = extractTextFromHtml(`
    <html>
      <head>
        <style>.x { color: red; }</style>
        <script>console.log("ignore")</script>
      </head>
      <body>
        <h1>Title</h1>
        <p>Hello <strong>world</strong>.</p>
      </body>
    </html>
  `);

  assert.match(text, /Title/);
  assert.match(text, /Hello world\./);
  assert.doesNotMatch(text, /console\.log/);
});

test("normalizeUrlContent keeps markdown and json as plain text", () => {
  assert.equal(normalizeUrlContent("# Title", "text/markdown"), "# Title");
  assert.equal(normalizeUrlContent("{\"ok\":true}", "application/json"), "{\"ok\":true}");
});

test("read_url fetches and normalizes html content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html><body><h1>Doc</h1><p>Body</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  try {
    const result = await readUrlTool.execute({ url: "https://example.com/doc" }, {
      traceId: "trace-1",
      now: () => new Date(),
    });

    assert.equal(result.url, "https://example.com/doc");
    assert.equal(result.contentType, "text/html");
    assert.match(result.content, /Doc/);
    assert.match(result.content, /Body/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseFeishuDocUrl supports docx and wiki URLs", () => {
  assert.deepEqual(
    parseFeishuDocUrl("https://feishu.cn/docx/AbCdEf123"),
    {
      sourceUrl: "https://feishu.cn/docx/AbCdEf123",
      kind: "docx",
      token: "AbCdEf123",
    },
  );

  assert.deepEqual(
    parseFeishuDocUrl("https://feishu.cn/wiki/QwErTy456"),
    {
      sourceUrl: "https://feishu.cn/wiki/QwErTy456",
      kind: "wiki",
      token: "QwErTy456",
    },
  );
});

test("read_url rejects Feishu doc links and points to the dedicated tool", async () => {
  await assert.rejects(
    async () => {
      await Promise.resolve(readUrlTool.execute({ url: "https://feishu.cn/docx/AbCdEf123" }, {
        traceId: "trace-2",
        now: () => new Date(),
      }));
    },
    /Use read_feishu_doc instead/,
  );
});

test("update_feishu_doc replaces docx content", async () => {
  const calls: string[] = [];
  const tool = createUpdateFeishuDocTool({
    id: "feishu",
    type: "feishu",
    appId: "app-id",
    appSecret: "app-secret",
  }, {
    docx: {
      document: {
        convert: async () => {
          calls.push("convert");
          return {
            code: 0,
            data: {
              first_level_block_ids: ["b1"],
              blocks: [{
                block_id: "b1",
                block_type: 2,
                children: [],
                text: {
                  elements: [{ text_run: { content: "Hello" } }],
                },
              }],
            },
          };
        },
      },
      documentBlock: {
        list: async () => {
          calls.push("list");
          return {
            code: 0,
            data: {
              items: [{ block_id: "old1", parent_id: "DocToken1", block_type: 2 }],
            },
          };
        },
      },
      documentBlockChildren: {
        batchDelete: async () => {
          calls.push("delete");
          return { code: 0, data: { document_revision_id: 2, client_token: "c1" } };
        },
      },
      documentBlockDescendant: {
        create: async () => {
          calls.push("insert");
          return { code: 0, data: { children: [] } };
        },
      },
    },
    wiki: {
      space: {
        getNode: async () => ({ code: 0, data: { node: {} } }),
      },
    },
  } as never);

  const result = await tool.execute({
    url: "https://feishu.cn/docx/DocToken1",
    content: "# Hello",
    mode: "replace",
  }, {
    traceId: "trace-3",
    now: () => new Date(),
  });

  assert.equal(result.docToken, "DocToken1");
  assert.equal(result.mode, "replace");
  assert.equal(result.clearedBlocks, 1);
  assert.equal(result.insertedBlocks, 1);
  assert.deepEqual(calls, ["list", "delete", "convert", "insert"]);
});

test("update_feishu_doc resolves wiki links before appending", async () => {
  let inserted = false;
  const tool = createUpdateFeishuDocTool({
    id: "feishu",
    type: "feishu",
    appId: "app-id",
    appSecret: "app-secret",
  }, {
    docx: {
      document: {
        convert: async () => ({
          code: 0,
          data: {
            first_level_block_ids: ["b1"],
            blocks: [{
              block_id: "b1",
              block_type: 2,
              children: [],
              text: {
                elements: [{ text_run: { content: "Append" } }],
              },
            }],
          },
        }),
      },
      documentBlock: {
        list: async () => ({ code: 0, data: { items: [] } }),
      },
      documentBlockChildren: {
        batchDelete: async () => ({ code: 0, data: { document_revision_id: 2, client_token: "c1" } }),
      },
      documentBlockDescendant: {
        create: async () => {
          inserted = true;
          return { code: 0, data: { children: [] } };
        },
      },
    },
    wiki: {
      space: {
        getNode: async () => ({
          code: 0,
          data: {
            node: {
              title: "Wiki Title",
              obj_type: "docx",
              obj_token: "ResolvedDoc1",
            },
          },
        }),
      },
    },
  } as never);

  const result = await tool.execute({
    url: "https://feishu.cn/wiki/WikiNode1",
    content: "Append",
    mode: "append",
  }, {
    traceId: "trace-4",
    now: () => new Date(),
  });

  assert.equal(result.sourceType, "wiki");
  assert.equal(result.docToken, "ResolvedDoc1");
  assert.equal(result.clearedBlocks, 0);
  assert.equal(inserted, true);
});
