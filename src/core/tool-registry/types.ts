import type { InferSchema, Schema, ValidationIssue } from "./schema.js";

export type ToolExecutionContext = {
  signal?: AbortSignal;
  traceId: string;
  now: () => Date;
};

export type ToolExecuteOptions = {
  signal?: AbortSignal;
  traceId?: string;
};

export type ToolSpec<
  TInputSchema extends Schema = Schema,
  TResult = unknown,
> = {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execute: (
    input: InferSchema<TInputSchema>,
    context: ToolExecutionContext,
  ) => Promise<TResult> | TResult;
};

export type ToolValidationError = {
  type: "validation_error";
  message: string;
  issues: ValidationIssue[];
};

export type ToolExecutionError = {
  type: "execution_error";
  message: string;
  cause?: unknown;
};

export type ToolLookupError = {
  type: "tool_not_found";
  message: string;
};

export type ToolAuthorizationError = {
  type: "authorization_error";
  message: string;
};

export type ToolError =
  | ToolValidationError
  | ToolExecutionError
  | ToolLookupError
  | ToolAuthorizationError;

export type ModelToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolResultEnvelope<TResult = unknown> = {
  toolName: string;
  traceId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: true;
  data: TResult;
} | {
  toolName: string;
  traceId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: false;
  error: ToolError;
};

export type TraceEvent =
  | {
      type: "tool_registered";
      toolName: string;
      at: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "tool_started";
      toolName: string;
      traceId: string;
      at: string;
      input: unknown;
    }
  | {
      type: "tool_succeeded";
      toolName: string;
      traceId: string;
      at: string;
      durationMs: number;
      output: unknown;
    }
  | {
      type: "tool_failed";
      toolName: string;
      traceId: string;
      at: string;
      durationMs: number;
      error: ToolError;
    };

export interface TraceLog {
  record(event: TraceEvent): void;
  list(): TraceEvent[];
  clear(): void;
}

export function defineTool<
  TInputSchema extends Schema,
  TResult,
>(tool: ToolSpec<TInputSchema, TResult>): ToolSpec<TInputSchema, TResult> {
  return tool;
}
