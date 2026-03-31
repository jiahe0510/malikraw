import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildFeishuOutboundPayload,
  buildFeishuFileMessageContent,
  classifyFeishuAttachment,
  extractFeishuText,
  FeishuChannel,
  isFeishuBotMentioned,
  isRetryableFeishuError,
  parseFeishuDeliveryContent,
  rememberMessageId,
  toChannelInboundMessage,
} from "../channels/feishu-channel.js";
import { clearWorkspaceRoot, setWorkspaceRoot } from "../index.js";

test("extractFeishuText returns trimmed text messages only", () => {
  assert.equal(extractFeishuText("text", JSON.stringify({ text: " hello " })), "hello");
  assert.equal(extractFeishuText("image", JSON.stringify({ image_key: "abc" })), undefined);
});

test("toChannelInboundMessage maps Feishu event metadata into a channel session", async () => {
  const message = await toChannelInboundMessage({
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

test("toChannelInboundMessage strips the bot mention placeholder from text content", async () => {
  const message = await toChannelInboundMessage({
    id: "feishu",
    agentId: "planner",
  }, {
    sender: {
      sender_type: "user",
    },
    message: {
      message_id: "om_strip",
      chat_id: "oc_strip",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 hi" }),
      mentions: [{
        key: "@_user_1",
        id: { open_id: "ou_bot" },
        name: "Bot",
      }],
    },
  }, {
    botOpenId: "ou_bot",
  });

  assert.equal(message?.content, "hi");
});

test("toChannelInboundMessage downloads inbound file attachments into the runtime directory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-feishu-inbound-"));
  setWorkspaceRoot(workspace);

  try {
    const message = await toChannelInboundMessage({
      id: "feishu",
      agentId: "planner",
    }, {
      sender: {
        sender_type: "user",
      },
      message: {
        message_id: "om_file",
        chat_id: "oc_file",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file-key",
          file_name: "report.md",
        }),
      },
    }, {
      client: {
        im: {
          messageResource: {
            get: async () => ({
              data: Buffer.from("# report\n"),
              headers: {
                "content-type": "text/markdown",
                "content-disposition": "attachment; filename=\"report.md\"",
              },
            }),
          },
        },
      },
    });

    assert.equal(message?.content, "[Feishu file]");
    assert.equal(message?.media?.length, 1);
    assert.match(message?.media?.[0]?.path ?? "", new RegExp(`${path.sep}\\.runtime${path.sep}feishu${path.sep}inbound${path.sep}`));
    assert.equal(await readFile(message?.media?.[0]?.path ?? "", "utf8"), "# report\n");
  } finally {
    clearWorkspaceRoot();
  }
});

test("isFeishuBotMentioned matches explicit mentions only", () => {
  assert.equal(isFeishuBotMentioned({
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: [],
    },
  }, "ou_bot"), false);

  assert.equal(isFeishuBotMentioned({
    message: {
      message_id: "om_2",
      chat_id: "oc_2",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 hello" }),
      mentions: [{
        key: "@_user_1",
        id: { open_id: "ou_bot" },
        name: "Bot",
      }],
    },
  }, "ou_bot"), true);
});

test("isFeishuBotMentioned detects rich-text post mentions", () => {
  assert.equal(isFeishuBotMentioned({
    message: {
      message_id: "om_post",
      chat_id: "oc_post",
      chat_type: "group",
      message_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "",
          content: [[{
            tag: "at",
            user_name: "Bot",
            open_id: "ou_bot",
          }, {
            tag: "text",
            text: " 请看下",
          }]],
        },
      }),
    },
  }, "ou_bot"), true);
});

test("FeishuChannel adds and removes a processing reaction around handled messages", async () => {
  const reactions: string[] = [];
  const channel = Object.assign(Object.create(FeishuChannel.prototype), {
    id: "feishu",
    config: {
      id: "feishu",
      type: "feishu",
      appId: "app-id",
      appSecret: "app-secret",
    },
    seenMessageIds: new Map<string, number>(),
  }) as FeishuChannel;

  (channel as unknown as {
    botOpenId?: string;
    client: {
      im: {
        messageReaction: {
          create: () => Promise<{ code: number; data: { reaction_id: string } }>;
          delete: () => Promise<{ code: number }>;
        };
      };
    };
  }).botOpenId = "ou_bot";

  (channel as unknown as {
    client: {
      im: {
        messageReaction: {
          create: () => Promise<{ code: number; data: { reaction_id: string } }>;
          delete: () => Promise<{ code: number }>;
        };
      };
    };
  }).client = {
    im: {
      messageReaction: {
        create: async () => {
          reactions.push("create");
          return { code: 0, data: { reaction_id: "reaction-1" } };
        },
        delete: async () => {
          reactions.push("delete");
          return { code: 0 };
        },
      },
    },
  };

  let handledContent = "";
  await (channel as unknown as {
    handleInboundEvent: (
      context: { handleMessage(message: { content: string }): Promise<void> },
      data: {
        sender: { sender_type: string };
        message: {
          message_id: string;
          chat_id: string;
          chat_type: string;
          message_type: string;
          content: string;
          mentions: Array<{ key: string; id: { open_id: string }; name: string }>;
        };
      },
    ) => Promise<void>;
  }).handleInboundEvent({
    handleMessage: async (message) => {
      handledContent = message.content;
    },
  }, {
    sender: {
      sender_type: "user",
    },
    message: {
      message_id: "om_react",
      chat_id: "oc_react",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Bot",
      }],
    },
  });

  assert.equal(handledContent, "hello");
  assert.deepEqual(reactions, ["create", "delete"]);
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

test("buildFeishuOutboundPayload strips markdown images from interactive cards", () => {
  const payload = buildFeishuOutboundPayload({}, "图如下：\n\n![Chart](https://example.com/chart.png)");
  assert.equal(payload.msgType, "interactive");
  assert.doesNotMatch(payload.content, /!\[Chart\]/);
  assert.match(payload.content, /\[image: Chart\]/);
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
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.mp3"), {
    kind: "file",
    uploadFileType: "stream",
    messageFileType: "file",
  });
  assert.deepEqual(classifyFeishuAttachment("/tmp/a.opus"), {
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

test("isRetryableFeishuError treats transient network failures as retryable", () => {
  assert.equal(isRetryableFeishuError({ code: "ECONNRESET", message: "read ECONNRESET" }), true);
  assert.equal(isRetryableFeishuError({ code: "ETIMEDOUT", message: "timeout" }), true);
  assert.equal(isRetryableFeishuError({ response: { status: 502 }, message: "bad gateway" }), true);
  assert.equal(isRetryableFeishuError({ code: "EINVAL", message: "bad request" }), false);
});
