import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const fileLocks = new Map<string, Promise<void>>();

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fallback;
    }
    if (isJsonParseError(error)) {
      await quarantineCorruptFile(filePath);
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function withFileLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(filePath, previous.then(() => current));

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (fileLocks.get(filePath) === current) {
      fileLocks.delete(filePath);
    }
  }
}

async function quarantineCorruptFile(filePath: string): Promise<void> {
  try {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    await rename(filePath, corruptPath);
    console.warn(`[memory:file:recover] moved corrupt file from ${filePath} to ${corruptPath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof Error && error.name === "SyntaxError";
}
