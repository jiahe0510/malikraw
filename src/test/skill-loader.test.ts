import test from "node:test";
import assert from "node:assert/strict";

import { parseSkillMarkdown } from "../index.js";

test("parseSkillMarkdown reads frontmatter and instruction body", () => {
  const skill = parseSkillMarkdown(`---
name: triage_incident
description: incident triage
promptRole: developer
tags: incident, production
version: 1
owner: runtime
allowedTools: lookup_service_status, check_logs
examples: Start with observed impact, Mark unknowns explicitly
---

Use facts first.
Call out unknowns clearly.
`);

  assert.equal(skill.name, "triage_incident");
  assert.equal(skill.description, "incident triage");
  assert.equal(skill.promptRole, "developer");
  assert.equal(skill.metadata?.version, "1");
  assert.deepEqual(skill.metadata?.tags, ["incident", "production"]);
  assert.deepEqual(skill.metadata?.allowedTools, ["lookup_service_status", "check_logs"]);
  assert.deepEqual(skill.metadata?.examples, ["Start with observed impact", "Mark unknowns explicitly"]);
  assert.match(skill.instruction, /Use facts first/);
});
