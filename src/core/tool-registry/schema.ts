export type PrimitiveSchema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | LiteralSchema
  | UnknownSchema;

export interface StringSchema {
  type: "string";
  minLength?: number;
  maxLength?: number;
}

export interface NumberSchema {
  type: "number";
  integer?: boolean;
  min?: number;
  max?: number;
}

export interface BooleanSchema {
  type: "boolean";
}

export interface LiteralSchema<TValue extends string | number | boolean | null = string | number | boolean | null> {
  type: "literal";
  value: TValue;
}

export interface UnknownSchema {
  type: "unknown";
}

export interface ArraySchema<TItem extends Schema = Schema> {
  type: "array";
  items: TItem;
  minItems?: number;
  maxItems?: number;
}

export interface ObjectSchema<
  TShape extends Record<string, Schema> = Record<string, Schema>,
  TRequired extends readonly (keyof TShape & string)[] = readonly (keyof TShape & string)[],
> {
  type: "object";
  properties: TShape;
  required?: TRequired;
  allowUnknownKeys?: boolean;
}

export interface UnionSchema<TOptions extends readonly Schema[] = readonly Schema[]> {
  type: "union";
  anyOf: TOptions;
}

export interface OptionalSchema<TInner extends Schema = Schema> {
  type: "optional";
  inner: TInner;
}

export type Schema =
  | PrimitiveSchema
  | ArraySchema
  | ObjectSchema
  | UnionSchema
  | OptionalSchema;

export type InferSchema<TSchema extends Schema> =
  TSchema extends { type: "string" } ? string :
  TSchema extends { type: "number" } ? number :
  TSchema extends { type: "boolean" } ? boolean :
  TSchema extends { type: "literal"; value: infer TValue } ? TValue :
  TSchema extends { type: "unknown" } ? unknown :
  TSchema extends { type: "array"; items: infer TItems extends Schema } ? InferSchema<TItems>[] :
  TSchema extends { type: "object"; properties: infer TProps extends Record<string, Schema>; required?: infer TRequired extends readonly string[] }
    ? InferObject<TProps, Extract<TRequired, readonly string[]>>
    : TSchema extends { type: "union"; anyOf: infer TOptions extends readonly Schema[] }
      ? InferSchema<TOptions[number]>
      : TSchema extends { type: "optional"; inner: infer TInner extends Schema }
        ? InferSchema<TInner> | undefined
        : never;

type InferObject<
  TProps extends Record<string, Schema>,
  TRequired extends readonly string[] | never = never,
> = {
  [K in keyof TProps as K extends RequiredKeys<TRequired> ? K : never]-?: InferSchema<TProps[K]>;
} & {
  [K in keyof TProps as K extends RequiredKeys<TRequired> ? never : K]?: InferSchema<TProps[K]>;
};

type RequiredKeys<TRequired extends readonly string[] | never> =
  TRequired extends readonly string[] ? TRequired[number] : never;

export type ValidationIssue = {
  path: string;
  message: string;
  expected: string;
  received: string;
};

export type ValidationResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; issues: ValidationIssue[] };

export const s = {
  string: (options: Omit<StringSchema, "type"> = {}): StringSchema => ({
    type: "string",
    ...options,
  }),
  number: (options: Omit<NumberSchema, "type"> = {}): NumberSchema => ({
    type: "number",
    ...options,
  }),
  boolean: (): BooleanSchema => ({ type: "boolean" }),
  literal: <const TValue extends string | number | boolean | null>(value: TValue): LiteralSchema<TValue> => ({ type: "literal", value }),
  unknown: (): UnknownSchema => ({ type: "unknown" }),
  array: <TItem extends Schema>(items: TItem, options: Omit<ArraySchema<TItem>, "type" | "items"> = {}): ArraySchema<TItem> => ({
    type: "array",
    items,
    ...options,
  }),
  object: <
    TShape extends Record<string, Schema>,
    const TRequired extends readonly (keyof TShape & string)[] = readonly [],
  >(
    properties: TShape,
    options: { required?: TRequired; allowUnknownKeys?: boolean } = {},
  ): ObjectSchema<TShape, TRequired> => ({
    type: "object",
    properties,
    ...options,
  }),
  union: <TOptions extends readonly Schema[]>(anyOf: TOptions): UnionSchema<TOptions> => ({
    type: "union",
    anyOf,
  }),
  optional: <TInner extends Schema>(inner: TInner): OptionalSchema<TInner> => ({
    type: "optional",
    inner,
  }),
};

export function validateSchema(
  schema: Schema,
  input: unknown,
): ValidationResult<unknown> {
  const issues = validateNode(schema, input, "$");

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: input };
}

function validateNode(schema: Schema, input: unknown, path: string): ValidationIssue[] {
  switch (schema.type) {
    case "string":
      return validateString(schema, input, path);
    case "number":
      return validateNumber(schema, input, path);
    case "boolean":
      return typeof input === "boolean" ? [] : [issue(path, "boolean", input)];
    case "literal":
      return Object.is(input, schema.value) ? [] : [{
        path,
        message: `Expected literal ${String(schema.value)}.`,
        expected: JSON.stringify(schema.value),
        received: describeValue(input),
      }];
    case "unknown":
      return [];
    case "array":
      return validateArray(schema, input, path);
    case "object":
      return validateObject(schema, input, path);
    case "union":
      return validateUnion(schema, input, path);
    case "optional":
      return input === undefined ? [] : validateNode(schema.inner, input, path);
    default:
      return assertNever(schema);
  }
}

function validateString(schema: Extract<PrimitiveSchema, { type: "string" }>, input: unknown, path: string): ValidationIssue[] {
  if (typeof input !== "string") {
    return [issue(path, "string", input)];
  }

  const issues: ValidationIssue[] = [];
  if (schema.minLength !== undefined && input.length < schema.minLength) {
    issues.push({
      path,
      message: `String must have length >= ${schema.minLength}.`,
      expected: `string(minLength:${schema.minLength})`,
      received: `string(length:${input.length})`,
    });
  }
  if (schema.maxLength !== undefined && input.length > schema.maxLength) {
    issues.push({
      path,
      message: `String must have length <= ${schema.maxLength}.`,
      expected: `string(maxLength:${schema.maxLength})`,
      received: `string(length:${input.length})`,
    });
  }
  return issues;
}

function validateNumber(schema: Extract<PrimitiveSchema, { type: "number" }>, input: unknown, path: string): ValidationIssue[] {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return [issue(path, "number", input)];
  }

  const issues: ValidationIssue[] = [];
  if (schema.integer && !Number.isInteger(input)) {
    issues.push({
      path,
      message: "Expected an integer.",
      expected: "integer",
      received: String(input),
    });
  }
  if (schema.min !== undefined && input < schema.min) {
    issues.push({
      path,
      message: `Number must be >= ${schema.min}.`,
      expected: `number(min:${schema.min})`,
      received: String(input),
    });
  }
  if (schema.max !== undefined && input > schema.max) {
    issues.push({
      path,
      message: `Number must be <= ${schema.max}.`,
      expected: `number(max:${schema.max})`,
      received: String(input),
    });
  }
  return issues;
}

function validateArray(schema: ArraySchema, input: unknown, path: string): ValidationIssue[] {
  if (!Array.isArray(input)) {
    return [issue(path, "array", input)];
  }

  const issues: ValidationIssue[] = [];
  if (schema.minItems !== undefined && input.length < schema.minItems) {
    issues.push({
      path,
      message: `Array must have at least ${schema.minItems} items.`,
      expected: `array(minItems:${schema.minItems})`,
      received: `array(length:${input.length})`,
    });
  }
  if (schema.maxItems !== undefined && input.length > schema.maxItems) {
    issues.push({
      path,
      message: `Array must have at most ${schema.maxItems} items.`,
      expected: `array(maxItems:${schema.maxItems})`,
      received: `array(length:${input.length})`,
    });
  }

  input.forEach((item, index) => {
    issues.push(...validateNode(schema.items, item, `${path}[${index}]`));
  });

  return issues;
}

function validateObject(schema: ObjectSchema, input: unknown, path: string): ValidationIssue[] {
  if (!isPlainObject(input)) {
    return [issue(path, "object", input)];
  }

  const issues: ValidationIssue[] = [];
    const required = new Set<string>(schema.required ?? []);
  const keys = Object.keys(schema.properties);
  const inputRecord = input as Record<string, unknown>;

  for (const key of keys) {
    const value = inputRecord[key];
    if (value === undefined) {
      if (required.has(key)) {
        issues.push({
          path: `${path}.${key}`,
          message: "Missing required field.",
          expected: "defined",
          received: "undefined",
        });
      }
      continue;
    }
    issues.push(...validateNode(schema.properties[key], value, `${path}.${key}`));
  }

  if (!schema.allowUnknownKeys) {
    for (const inputKey of Object.keys(inputRecord)) {
      if (!(inputKey in schema.properties)) {
        issues.push({
          path: `${path}.${inputKey}`,
          message: "Unknown field is not allowed.",
          expected: keys.join(", "),
          received: inputKey,
        });
      }
    }
  }

  return issues;
}

function validateUnion(schema: UnionSchema, input: unknown, path: string): ValidationIssue[] {
  const branchIssues = schema.anyOf.map((branch) => validateNode(branch, input, path));
  if (branchIssues.some((issues) => issues.length === 0)) {
    return [];
  }

  return [{
    path,
    message: "Input did not match any union branch.",
    expected: schema.anyOf.map(describeSchema).join(" | "),
    received: describeValue(input),
  }];
}

function issue(path: string, expected: string, input: unknown): ValidationIssue {
  return {
    path,
    message: `Expected ${expected}.`,
    expected,
    received: describeValue(input),
  };
}

function describeSchema(schema: Schema): string {
  switch (schema.type) {
    case "string":
    case "number":
    case "boolean":
    case "unknown":
      return schema.type;
    case "literal":
      return JSON.stringify(schema.value);
    case "array":
      return `Array<${describeSchema(schema.items)}>`;
    case "object":
      return `Object<{${Object.keys(schema.properties).join(",")}}>`;
    case "union":
      return schema.anyOf.map(describeSchema).join(" | ");
    case "optional":
      return `${describeSchema(schema.inner)} | undefined`;
    default:
      return assertNever(schema);
  }
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled schema node: ${JSON.stringify(value)}`);
}
