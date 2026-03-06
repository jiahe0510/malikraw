import type { TraceEvent, TraceLog } from "./types.js";

export class InMemoryTraceLog implements TraceLog {
  private readonly events: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.events.push(event);
  }

  list(): TraceEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}
