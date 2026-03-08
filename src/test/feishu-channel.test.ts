import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildFeishuOutboundPayload,
  buildFeishuFileMessageContent,
  classifyFeishuAttachment,
  extractFeishuText,
  parseFeishuDeliveryContent,
  rememberMessageId,
  toChannelInboundMessage,
} from "../channels/feishu-channel.js";
import { clearWorkspaceRoot, setWorkspaceRoot } from "../index.js";

test("extractFeishuText returns trimmed text messages only", () => {
  assert.equal(extractFeishuText("text", JSON.stringify({ text: " hello " })), "hello");
  assert.equal(extractFeishuText("image", JSON.stringify({ image_key: "abc" })), undefined);
});

test("toChannelInboundMessage maps Feishu event metadata into a channel session", () => {
  const message = toChannelInboundMessage({
    id: "feishu",
    agentId: "planner",
  }, {
    sender: {
      sender_type: "user",
    },
    message: {
      message_id: "om_xxx",
      chat_id: "oc_xxx",
      thread_id: "ot_xxx",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  });

  assert.deepEqual(message, {
    session: {
      agentId: "planner",
      channelId: "feishu",
      sessionId: "ot_xxx",
      metadata: {
        feishuReplyMessageId: "om_xxx",
        feishuChatId: "oc_xxx",
        feishuThreadId: "ot_xxx",
      },
    },
    content: "hello",
  });
});

test("rememberMessageId deduplicates repeated Feishu message ids and expires old entries", () => {
  const seen = new Map<string, number>();

  assert.equal(rememberMessageId(seen, "om_1", 1000, 100, 10), true);
  assert.equal(rememberMessageId(seen, "om_1", 1001, 100, 10), false);
  assert.equal(rememberMessageId(seen, "om_2", 1150, 100, 10), true);
  assert.equal(rememberMessageId(seen, "om_1", 1201, 100, 10), true);
});

test("buildFeishuOutboundPayload uses interactive cards for markdown rendering by default", () => {
  const payload = buildFeishuOutboundPayload({}, "# Title\n\n- a\n\n[OpenAI](https://openai.com)\n\n`code`");
  assert.equal(payload.msgType, "interactive");
  assert.match(payload.content, /"tag":"markdown"/);
  assert.match(payload.content, /\*\*Title\*\*/);
  assert.match(payload.content, /- a/);
  assert.match(payload.content, /\[OpenAI\]\(https:\/\/openai\.com\)/);
  assert.match(payload.content, /code/);
});

test("buildFeishuOutboundPayload degrades fenced code blocks into indented text", () => {
  const payload = buildFeishuOutboundPayload({}, "```ts\nconst x = 1;\n```");
  assert.equal(payload.msgType, "interactive");
  assert.match(payload.content, /    const x = 1;/);
});

test("buildFeishuOutboundPayload can still emit plain text", () => {
  const payload = buildFeishuOutboundPayload({ messageFormat: "text" }, "hello");
  assert.equal(payload.msgType, "text");
  assert.equal(payload.content, JSON.stringify({ text: "hello" }));
});

test("classifyFeishuAttachment maps common file types", () => {
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.png"), { kind: "image" });
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.pdf"), {
    kind: "file",
    uploadFileType: "pdf",
    messageFileType: "pdf",
  });
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.docx"), {
    kind: "file",
    uploadFileType: "doc",
    messageFileType: "file",
  });
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.bin"), {
    kind: "file",
    uploadFileType: "stream",
    messageFileType: "file",
  });
});

test("buildFeishuFileMessageContent includes file metadata", () => {
  assert.equal(
    buildFeishuFileMessageContent("file-key", "pdf", "report.pdf"),
    JSON.stringify({
      file_key: "file-key",
      file_type: "pdf",
      file_name: "report.pdf",
    }),
  );
});

test("parseFeishuDeliveryContent separates text from attachment paths", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-feishu-"));
  setWorkspaceRoot(workspace);

  try {
    const filePath = path.join(workspace, "report.pdf");
    await writeFile(filePath, "dummy", "utf8");

    const parsed = await parseFeishuDeliveryContent("Here is the report\nreport.pdf");
    assert.equal(parsed.text, "Here is the report");
    assert.deepEqual(parsed.attachmentPaths, [filePath]);
  } finally {
    clearWorkspaceRoot();
  }
});

test("parseFeishuDeliveryContent supports explicit feishu attachment directives", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-feishu-"));
  setWorkspaceRoot(workspace);

  try {
    const imagePath = path.join(workspace, "chart.png");
    await writeFile(imagePath, "dummy", "utf8");

    const parsed = await parseFeishuDeliveryContent("分析结果如下\n[feishu:image] chart.png");
    assert.equal(parsed.text, "分析结果如下");
    assert.deepEqual(parsed.attachmentPaths, [imagePath]);
  } finally {
    clearWorkspaceRoot();
  }
});
