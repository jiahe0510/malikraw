import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function getWorkspaceRoot(): string {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { cwd: () => string };
  };

  if (!maybeProcess.process) {
    throw new Error("Node.js process object is not available.");
  }

  return maybeProcess.process.cwd();
}

export function resolveWorkspacePath(targetPath: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const absolutePath = path.resolve(workspaceRoot, targetPath);

  if (!isSubpath(absolutePath, workspaceRoot)) {
    throw new Error(`Path "${targetPath}" resolves outside the workspace root.`);
  }

  return absolutePath;
}

export async function ensureParentDirectory(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
}

export async function createProcessLogDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agent-core-process-"));
}

export async function readOptionalFile(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

function isSubpath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
