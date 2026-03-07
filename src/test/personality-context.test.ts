import test from "node:test";
import assert from "node:assert/strict";

import {
  readBundledPersonalityFile,
  readDefaultAgentTemplateFile,
} from "../runtime/system-template-context.js";

test("runtime can read bundled PERSONALITY.md", async () => {
  const content = await readBundledPersonalityFile();

  assert.match(content ?? "", /Malikraw Personality/);
  assert.match(content ?? "", /## Tone/);
});

test("runtime can read bundled AGENT.md template", async () => {
  const content = await readDefaultAgentTemplateFile();

  assert.match(content ?? "", /Workspace Agent/);
  assert.match(content ?? "", /## Workspace Responsibilities/);
});
