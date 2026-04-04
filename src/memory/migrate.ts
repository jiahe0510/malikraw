import { mkdir } from "node:fs/promises";

import { getMemoryStoreDirectory } from "./session-store.js";

export async function runMemoryMigrations(): Promise<void> {
  await mkdir(getMemoryStoreDirectory(), { recursive: true });
  console.log("[memory:migrate] local memory store ready");
}
