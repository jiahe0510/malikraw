import { validateSchema } from "./schema.js";
import type { Schema } from "./schema.js";
import type {
  ToolError,
  ToolExecuteOptions,
  ToolExecutionContext,
  ToolExecutionError,
  ToolLookupError,
  ToolResultEnvelope,
  ToolValidationError,
  TraceLog,
} from "./types.js";

type ExecutableTool = {
  name: string;
  inputSchema: Schema;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown> | unknown;
};

export async function executeTool<TResult = unknown>(input: {
  toolName: string;
  rawInput: unknown;
  traceLog: TraceLog;
  tool?: ExecutableTool;
  options?: ToolExecuteOptions;
}): Promise<ToolResultEnvelope<TResult>> {
  const startedAt = new Date();
  const traceId = input.options?.traceId ?? createTraceId();
  if (!input.tool) {
    return fail(input.toolName, traceId, startedAt, lookupError(input.toolName), input.traceLog);
  }

  input.traceLog.record({
    type: "tool_started",
    toolName: input.toolName,
    traceId,
    at: startedAt.toISOString(),
    input: input.rawInput,
  });
  console.log(
    `[tool:start] name=${input.toolName} trace=${traceId} input=${formatForLog(input.rawInput)}`,
  );

  const validation = validateSchema(input.tool.inputSchema, input.rawInput);
  if (!validation.ok) {
    return fail(input.toolName, traceId, startedAt, {
      type: "validation_error",
      message: `Input validation failed for tool "${input.toolName}".`,
      issues: validation.issues,
    }, input.traceLog);
  }

  const context: ToolExecutionContext = {
    signal: input.options?.signal,
    traceId,
    now: () => new Date(),
  };

  try {
    const data = await input.tool.execute(validation.value, context);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    input.traceLog.record({
      type: "tool_succeeded",
      toolName: input.toolName,
      traceId,
      at: finishedAt.toISOString(),
      durationMs,
      output: data,
    });
    console.log(
      `[tool:success] name=${input.toolName} trace=${traceId} duration_ms=${durationMs} output=${formatForLog(data)}`,
    );

    return {
      toolName: input.toolName,
      traceId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      ok: true,
      data: data as TResult,
    };
  } catch (error) {
    return fail(input.toolName, traceId, startedAt, toExecutionError(input.toolName, error), input.traceLog);
  }
}

function fail(
  toolName: string,
  traceId: string,
  startedAt: Date,
  error: ToolError,
  traceLog: TraceLog,
): ToolResultEnvelope<never> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  traceLog.record({
    type: "tool_failed",
    toolName,
    traceId,
    at: finishedAt.toISOString(),
    durationMs,
    error,
  });
  console.log(
    `[tool:fail] name=${toolName} trace=${traceId} duration_ms=${durationMs} error=${formatForLog(error)}`,
  );

  return {
    toolName,
    traceId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    ok: false,
    error,
  };
}

function lookupError(toolName: string): ToolLookupError {
  return {
    type: "tool_not_found",
    message: `Tool "${toolName}" is not registered.`,
  };
}

function toExecutionError(toolName: string, cause: unknown): ToolExecutionError {
  const message = cause instanceof Error
    ? cause.message
    : `Tool "${toolName}" failed with a non-Error throw value.`;

  return {
    type: "execution_error",
    message,
    cause,
  };
}

function createTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatForLog(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), 500);
  } catch {
    return truncate(String(value), 500);
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
