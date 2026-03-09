import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileBackedTaskStore } from "../index.js";

test("file-backed task store persists roots, steps, and events to disk", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "malikraw-a2a-"));
  const store = new FileBackedTaskStore(directory);

  const root = await store.createRootTask({
    input: { query: "analyze repo" },
  });
  const step = await store.createStepTask({
    rootTaskId: root.id,
    stepName: "sub-a",
    agentId: "sub-a",
    input: { userRequest: "scan repo" },
  });

  await store.markStepRunning(step.id);
  await store.appendStepEvent({
    id: "event_1",
    type: "step.started",
    rootTaskId: root.id,
    stepId: step.id,
    at: new Date().toISOString(),
  });
  await store.markStepCompleted(step.id, {
    output: { needB: false },
  });
  await store.markRootCompleted(root.id, {
    finalOutput: { finalSummary: "done" },
  });

  const rootFile = path.join(directory, "roots", root.id, "root.json");
  const stepFile = path.join(directory, "roots", root.id, "steps", `${step.id}.json`);
  const eventsFile = path.join(directory, "roots", root.id, "events.json");

  const rootJson = JSON.parse(await readFile(rootFile, "utf8")) as { status: string; finalOutput: unknown };
  const stepJson = JSON.parse(await readFile(stepFile, "utf8")) as { status: string; output: unknown };
  const eventsJson = JSON.parse(await readFile(eventsFile, "utf8")) as Array<{ type: string }>;

  assert.equal(rootJson.status, "completed");
  assert.deepEqual(rootJson.finalOutput, { finalSummary: "done" });
  assert.equal(stepJson.status, "completed");
  assert.deepEqual(stepJson.output, { needB: false });
  assert.equal(eventsJson[0]?.type, "step.started");
});
