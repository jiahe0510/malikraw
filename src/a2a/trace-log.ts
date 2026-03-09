import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

export type A2ATraceEntry = {
  at: string;
  kind: string;
  payload: unknown;
};

export interface A2ATraceLog {
  record(rootTaskId: string, entry: A2ATraceEntry): Promise<void>;
}

export class FileBackedA2ATraceLog implements A2ATraceLog {
  constructor(private readonly baseDirectory: string) {}

  async record(rootTaskId: string, entry: A2ATraceEntry): Promise<void> {
    const filePath = path.join(this.baseDirectory, "roots", rootTaskId, "chain.ndjson");
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
