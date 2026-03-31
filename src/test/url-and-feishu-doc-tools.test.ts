import test from "node:test";
import assert from "node:assert/strict";

import { parseFeishuDocUrl } from "../tools/read-feishu-doc.js";
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
