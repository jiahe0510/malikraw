import { validateSchema, type ObjectSchema, type Schema } from "./schema.js";
import { InMemoryTraceLog } from "./trace-log.js";
import type {
  ModelToolDefinition,
  ToolError,
  ToolExecutionContext,
  ToolExecutionError,
  ToolLookupError,
  ToolResultEnvelope,
  ToolSpec,
  TraceLog,
} from "./types.js";

type ExecuteOptions = {
  signal?: AbortSignal;
  traceId?: string;
};

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Schema;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown> | unknown;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  readonly traceLog: TraceLog;

  constructor(options: { traceLog?: TraceLog } = {}) {
    this.traceLog = options.traceLog ?? new InMemoryTraceLog();
  }

  register<TTool extends ToolSpec>(tool: TTool): TTool {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }

    this.tools.set(tool.name, tool as unknown as RegisteredTool);
    this.traceLog.record({
      type: "tool_registered",
      toolName: tool.name,
      at: new Date().toISOString(),
      metadata: { description: tool.description },
    });

    return tool;
  }

  get(toolName: string): RegisteredTool | undefined {
    return this.tools.get(toolName);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  toModelTools(toolNames?: readonly string[]): ModelToolDefinition[] {
    return this.listVisible(toolNames).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schemaToJsonSchema(tool.inputSchema),
      },
    }));
  }

  describeTools(toolNames?: readonly string[]): string {
    const tools = this.listVisible(toolNames);
    if (tools.length === 0) {
      return "No tools are currently available.";
    }

    return tools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join("\n");
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  async execute<TResult = unknown>(
    toolName: string,
    rawInput: unknown,
    options: ExecuteOptions = {},
  ): Promise<ToolResultEnvelope<TResult>> {
    const startedAt = new Date();
    const traceId = options.traceId ?? createTraceId();
    const tool = this.tools.get(toolName);

    if (!tool) {
      return this.fail(toolName, traceId, startedAt, lookupError(toolName));
    }

    this.traceLog.record({
      type: "tool_started",
      toolName,
      traceId,
      at: startedAt.toISOString(),
      input: rawInput,
    });

    const validation = validateSchema(tool.inputSchema, rawInput);
    if (!validation.ok) {
      return this.fail(toolName, traceId, startedAt, {
        type: "validation_error",
        message: `Input validation failed for tool "${toolName}".`,
        issues: validation.issues,
      });
    }

    const context: ToolExecutionContext = {
      signal: options.signal,
      traceId,
      now: () => new Date(),
    };

    try {
      const data = await tool.execute(validation.value, context);
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      this.traceLog.record({
        type: "tool_succeeded",
        toolName,
        traceId,
        at: finishedAt.toISOString(),
        durationMs,
        output: data,
      });

      return {
        toolName,
        traceId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        ok: true,
        data: data as TResult,
      };
    } catch (error) {
      return this.fail(toolName, traceId, startedAt, toExecutionError(toolName, error));
    }
  }

  private fail(
    toolName: string,
    traceId: string,
    startedAt: Date,
    error: ToolError,
  ): ToolResultEnvelope<never> {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    this.traceLog.record({
      type: "tool_failed",
      toolName,
      traceId,
      at: finishedAt.toISOString(),
      durationMs,
      error,
    });

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

  private listVisible(toolNames?: readonly string[]): RegisteredTool[] {
    if (!toolNames || toolNames.length === 0) {
      return this.list();
    }

    const allowed = new Set(toolNames);
    return this.list().filter((tool) => allowed.has(tool.name));
  }
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

function schemaToJsonSchema(schema: Schema): Record<string, unknown> {
  switch (schema.type) {
    case "string":
      return compact({
        type: "string",
        minLength: schema.minLength,
        maxLength: schema.maxLength,
      });
    case "number":
      return compact({
        type: "number",
        minimum: schema.min,
        maximum: schema.max,
        multipleOf: schema.integer ? 1 : undefined,
      });
    case "boolean":
      return { type: "boolean" };
    case "literal":
      return { const: schema.value };
    case "unknown":
      return {};
    case "array":
      return compact({
        type: "array",
        items: schemaToJsonSchema(schema.items),
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      });
    case "object":
      return objectSchemaToJsonSchema(schema);
    case "union":
      return {
        anyOf: schema.anyOf.map((item) => schemaToJsonSchema(item)),
      };
    case "optional":
      return {
        anyOf: [
          schemaToJsonSchema(schema.inner),
          { type: "null" },
        ],
      };
    default:
      return assertNever(schema);
  }
}

function objectSchemaToJsonSchema(schema: ObjectSchema): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [key, schemaToJsonSchema(value)]),
  );

  return compact({
    type: "object",
    properties,
    required: schema.required ? [...schema.required] : undefined,
    additionalProperties: schema.allowUnknownKeys ?? false,
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled schema node: ${JSON.stringify(value)}`);
}
