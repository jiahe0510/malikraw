import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getServiceLogInfo,
  getServicePidFilePath,
  getServiceStatus,
  stopBackgroundService,
} from "../cli/service-manager.js";

test("service status reports missing when no metadata exists", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-service-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const status = getServiceStatus();
    assert.deepEqual(status, {
      running: false,
      reason: "missing",
    });
  } finally {
    restoreHome(previousHome);
  }
});

test("service status clears stale pid metadata", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-service-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const pidFile = getServicePidFilePath();
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(
      pidFile,
      `${JSON.stringify({
        pid: 999999,
        startedAt: "2026-03-07T00:00:00.000Z",
        command: "node dist/cli.js serve",
        logPath: path.join(malikrawHome, "log", "service.log"),
      })}\n`,
      "utf8",
    );

    const status = getServiceStatus();
    assert.deepEqual(status, {
      running: false,
      reason: "stale",
    });

    await assert.rejects(readFile(pidFile, "utf8"));
  } finally {
    restoreHome(previousHome);
  }
});

test("stopBackgroundService is safe when service is missing", async () => {
  const malikrawHome = await mkdtemp(path.join(tmpdir(), "malikraw-service-home-"));
  const previousHome = process.env.MALIKRAW_HOME;
  process.env.MALIKRAW_HOME = malikrawHome;

  try {
    const status = stopBackgroundService();
    assert.deepEqual(status, {
      running: false,
      reason: "missing",
    });

    const logInfo = getServiceLogInfo();
    assert.match(logInfo.logPath, /\/log\/service\.log$/);
    assert.equal(logInfo.sizeBytes, undefined);
  } finally {
    restoreHome(previousHome);
  }
});

function restoreHome(previousHome: string | undefined): void {
  if (previousHome === undefined) {
    delete process.env.MALIKRAW_HOME;
    return;
  }

  process.env.MALIKRAW_HOME = previousHome;
}
