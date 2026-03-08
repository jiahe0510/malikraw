import { createClient } from "redis";

import type { MemoryContext, SessionStateRecord, SessionStateStore } from "./types.js";

type StringKeyValueClient = {
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

export class InMemorySessionStateStore implements SessionStateStore {
  private readonly records = new Map<string, SessionStateRecord>();

  async read(context: MemoryContext): Promise<SessionStateRecord | undefined> {
    return this.records.get(buildSessionStateKey(context));
  }

  async write(record: SessionStateRecord): Promise<void> {
    this.records.set(buildSessionStateKey(record), record);
  }
}

export class RedisSessionStateStore implements SessionStateStore {
  private connected = false;

  constructor(
    private readonly client: StringKeyValueClient,
    private readonly keyPrefix = "malikraw:session-state:",
  ) {}

  static fromUrl(redisUrl: string): RedisSessionStateStore {
    return new RedisSessionStateStore(createClient({ url: redisUrl }) as unknown as StringKeyValueClient);
  }

  async read(context: MemoryContext): Promise<SessionStateRecord | undefined> {
    await this.ensureConnected();
    const raw = await this.client.get(this.keyFor(context));
    return raw ? JSON.parse(raw) as SessionStateRecord : undefined;
  }

  async write(record: SessionStateRecord): Promise<void> {
    await this.ensureConnected();
    await this.client.set(this.keyFor(record), JSON.stringify(record));
  }

  private keyFor(context: Pick<MemoryContext, "sessionId" | "agentId" | "userId">): string {
    return `${this.keyPrefix}${context.userId}:${context.agentId}:${context.sessionId}`;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }
}

function buildSessionStateKey(context: Pick<MemoryContext, "sessionId" | "agentId" | "userId">): string {
  return `${context.userId}:${context.agentId}:${context.sessionId}`;
}
