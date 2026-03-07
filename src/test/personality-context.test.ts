import test from "node:test";
import assert from "node:assert/strict";

import {
  readBundledPersonalityFile,
  readDefaultAgentTemplateFile,
  readDefaultIdentityTemplateFile,
} from "../runtime/system-template-context.js";

test("runtime can read bundled PERSONALITY.md", async () => {
  const content = await readBundledPersonalityFile();

  assert.match(content ?? "", /# PERSONALITY\.md/);
  assert.match(content ?? "", /Malikraw should feel warm, alive, and close to the user/);
});

test("runtime can read bundled AGENT.md template", async () => {
  const content = await readDefaultAgentTemplateFile();

  assert.match(content ?? "", /# AGENT\.md/);
  assert.match(content ?? "", /This Agent exists to stay close to the user/);
});

test("runtime can read bundled IDENTITY.md template", async () => {
  const content = await readDefaultIdentityTemplateFile();

  assert.match(content ?? "", /Malikraw Identity/);
  assert.match(content ?? "", /## Who You Are/);
});
