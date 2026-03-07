import type { AgentMessage } from "../core/agent/types.js";
import type { ChannelSession } from "./channel.js";

export interface SessionStore {
  read(session: ChannelSession): Promise<AgentMessage[]> | AgentMessage[];
  write(session: ChannelSession, messages: AgentMessage[]): Promise<void> | void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentMessage[]>();

  read(session: ChannelSession): AgentMessage[] {
    return [...(this.sessions.get(toSessionKey(session)) ?? [])];
  }

  write(session: ChannelSession, messages: AgentMessage[]): void {
    this.sessions.set(toSessionKey(session), [...messages]);
  }
}

function toSessionKey(session: ChannelSession): string {
  return `${session.agentId ?? "default"}:${session.channelId}:${session.sessionId}`;
}
