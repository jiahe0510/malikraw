import test from "node:test";
import assert from "node:assert/strict";

import { parseSkillMarkdown } from "../index.js";

test("parseSkillMarkdown reads frontmatter and instruction body", () => {
  const skill = parseSkillMarkdown(`---
name: workspace_operator
description: workspace operations
promptRole: developer
tags: workspace, shell
version: 1
owner: runtime
allowedTools: read_file, exec_shell
examples: Read before editing, Explain command purpose
---

Inspect the workspace first.
Explain each step clearly.
`);

  assert.equal(skill.name, "workspace_operator");
  assert.equal(skill.description, "workspace operations");
  assert.equal(skill.promptRole, "developer");
  assert.equal(skill.metadata?.version, "1");
  assert.deepEqual(skill.metadata?.tags, ["workspace", "shell"]);
  assert.deepEqual(skill.metadata?.allowedTools, ["read_file", "exec_shell"]);
  assert.deepEqual(skill.metadata?.examples, ["Read before editing", "Explain command purpose"]);
  assert.match(skill.instruction, /Inspect the workspace first/);
});
