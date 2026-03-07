import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installBundledSkills, listBundledSkillIds } from "../runtime/bundled-skills.js";

test("bundled skills can be listed from repository skills directory", async () => {
  const skillIds = await listBundledSkillIds();

  assert.ok(skillIds.includes("workspace_operator"));
});

test("bundled skills can be copied into a workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-bundled-skills-"));

  await installBundledSkills(["workspace_operator"], workspace);

  const copiedPath = path.join(workspace, "skills", "workspace_operator", "SKILL.md");
  const fileInfo = await stat(copiedPath);
  assert.equal(fileInfo.isFile(), true);

  const content = await readFile(copiedPath, "utf8");
  assert.match(content, /name: workspace_operator/);
});
