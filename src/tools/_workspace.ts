import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";

export { getWorkspaceRoot } from "../runtime/workspace-context.js";
import { getRuntimeDirectory, getWorkspaceRoot } from "../runtime/workspace-context.js";

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
  const processesRoot = path.join(getRuntimeDirectory(), "processes");
  await mkdir(processesRoot, { recursive: true });
  return mkdtemp(path.join(processesRoot, "proc-"));
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
