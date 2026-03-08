import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ToolRegistry, clearWorkspaceRoot, registerBuiltinTools, setWorkspaceRoot } from "../index.js";

test("message tool returns a structured dispatch with resolved media", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "malikraw-message-tool-"));
  setWorkspaceRoot(workspace);

  try {
    const imagePath = path.join(workspace, "chart.png");
    await writeFile(imagePath, "png", "utf8");

    const registry = registerBuiltinTools(new ToolRegistry());
    const result = await registry.execute("message", {
      content: "Here is the chart",
      media: [{
        path: "chart.png",
      }],
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.deepEqual(result.data, {
      content: "Here is the chart",
      media: [{
        kind: "image",
        path: imagePath,
        fileName: "chart.png",
      }],
    });
  } finally {
    clearWorkspaceRoot();
  }
});
