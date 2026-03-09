import type { ArtifactRef } from "./types.js";

export type WriteArtifactInput = {
  rootTaskId: string;
  stepId: string;
  fileName: string;
  content: string;
  mimeType?: string;
};

export interface ArtifactStore {
  writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef>;
}
