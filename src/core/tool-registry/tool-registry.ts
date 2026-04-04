import { type ObjectSchema, type Schema } from "./schema.js";
import { executeTool } from "./tool-executor.js";
import { InMemoryTraceLog } from "./trace-log.js";
import type {
  ModelToolDefinition,
  ToolExecuteOptions,
  ToolExecutionContext,
  ToolResultEnvelope,
  ToolSpec,
  TraceLog,
} from "./types.js";

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
    options: ToolExecuteOptions = {},
  ): Promise<ToolResultEnvelope<TResult>> {
    return executeTool({
      toolName,
      rawInput,
      tool: this.tools.get(toolName),
      traceLog: this.traceLog,
      options,
    });
  }

  private listVisible(toolNames?: readonly string[]): RegisteredTool[] {
    if (!toolNames || toolNames.length === 0) {
      return this.list();
    }

    const allowed = new Set(toolNames);
    return this.list().filter((tool) => allowed.has(tool.name));
  }
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
