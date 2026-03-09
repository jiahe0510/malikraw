import type { AssignmentHandler, EventBus, StepEventHandler } from "./event-bus.js";
import type { StepAssignment, StepEvent } from "./types.js";

export class InMemoryEventBus implements EventBus {
  private readonly assignmentHandlers = new Map<string, Set<AssignmentHandler>>();
  private readonly eventHandlers = new Set<StepEventHandler>();

  async publishAssignment(assignment: StepAssignment): Promise<void> {
    const handlers = [...(this.assignmentHandlers.get(assignment.agentId) ?? [])];
    await Promise.all(handlers.map(async (handler) => {
      await handler(assignment);
    }));
  }

  async publishEvent(event: StepEvent): Promise<void> {
    const handlers = [...this.eventHandlers];
    await Promise.all(handlers.map(async (handler) => {
      await handler(event);
    }));
  }

  subscribeAssignments(agentId: string, handler: AssignmentHandler): () => void {
    const handlers = this.assignmentHandlers.get(agentId) ?? new Set<AssignmentHandler>();
    handlers.add(handler);
    this.assignmentHandlers.set(agentId, handlers);
    return () => {
      const current = this.assignmentHandlers.get(agentId);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.assignmentHandlers.delete(agentId);
      }
    };
  }

  subscribeEvents(handler: StepEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }
}
