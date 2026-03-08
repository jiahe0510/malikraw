import test from "node:test";
import assert from "node:assert/strict";

import { loadRuntimeConfig } from "../index.js";

test("loadRuntimeConfig keeps configured embedding dimensions", () => {
  const config = loadRuntimeConfig();
  if (!config.memory) {
    assert.equal(config.memory, undefined);
    return;
  }

  assert.equal(typeof config.memory.embeddingDimensions, "number");
  assert.ok(config.memory.embeddingDimensions > 0);
});
