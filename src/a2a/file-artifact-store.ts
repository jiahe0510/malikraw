import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTaskId, type ArtifactRef } from "./types.js";
import type { ArtifactStore, WriteArtifactInput } from "./artifact-store.js";

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly baseDirectory: string) {}

  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef> {
    const id = createTaskId("artifact");
    const directory = path.join(this.baseDirectory, input.rootTaskId, input.stepId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, input.fileName);
    await writeFile(filePath, input.content, "utf8");
    return {
      id,
      path: filePath,
      mimeType: input.mimeType,
    };
  }
}
