import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { getMalikrawHomeDirectory } from "../config/config-store.js";

export type ObservabilityLevel = "info" | "warn" | "error";

export type RuntimeObservation = {
  name: string;
  message?: string;
  level?: ObservabilityLevel;
  data?: Record<string, unknown>;
  at?: string;
};

export type RuntimeLogEntry = {
  name: string;
  message?: string;
  level?: ObservabilityLevel;
  data?: Record<string, unknown>;
  at?: string;
};

const MAX_FIELD_LENGTH = 600;

export function getLogDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), "log");
}

export function getEventDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), "event");
}

export function getRuntimeLogFilePath(): string {
  return path.join(getLogDirectory(), "runtime.log");
}

export function getRuntimeEventFilePath(): string {
  return path.join(getEventDirectory(), "runtime.jsonl");
}

export function getServiceLogFilePath(): string {
  return path.join(getLogDirectory(), "service.log");
}

export function recordRuntimeObservation(input: RuntimeObservation): void {
  const event = {
    at: input.at ?? new Date().toISOString(),
    level: input.level ?? "info",
    event: `[${input.name}]`,
    name: input.name,
    message: input.message,
    data: sanitizeRecord(input.data),
  };

  try {
    ensureObservabilityDirectories();
    appendFileSync(getRuntimeEventFilePath(), `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return;
    }
    throw error;
  }
}

export function recordRuntimeLog(input: RuntimeLogEntry): void {
  const entry = {
    at: input.at ?? new Date().toISOString(),
    level: input.level ?? "info",
    name: input.name,
    message: input.message,
    data: sanitizeRecord(input.data),
  };

  try {
    ensureObservabilityDirectories();
    appendFileSync(getRuntimeLogFilePath(), `${formatLogLine(entry)}\n`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return;
    }
    throw error;
  }
}

function ensureObservabilityDirectories(): void {
  mkdirSync(getLogDirectory(), { recursive: true });
  mkdirSync(getEventDirectory(), { recursive: true });
}

function formatLogLine(event: {
  at: string;
  level: ObservabilityLevel;
  name: string;
  message?: string;
  data?: Record<string, unknown>;
}): string {
  const parts = [
    `[${event.at}]`,
    `[${event.level}]`,
    `[${event.name}]`,
  ];

  if (event.message) {
    parts.push(event.message);
  }

  const fields = formatFields(event.data);
  if (fields) {
    parts.push(fields);
  }

  return parts.join(" ");
}

function formatFields(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return "";
  }

  return Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${serializeField(value)}`)
    .join(" ");
}

function serializeField(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncate(value));
  }

  if (
    typeof value === "number"
    || typeof value === "boolean"
    || value === null
  ) {
    return String(value);
  }

  return JSON.stringify(truncate(safeJson(value)));
}

function sanitizeRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeValue(value)]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value);
  }

  if (
    typeof value === "number"
    || typeof value === "boolean"
    || value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) {
        result[key] = sanitizeValue(entry);
      }
    }
    return result;
  }

  return truncate(String(value));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string): string {
  return value.length <= MAX_FIELD_LENGTH ? value : `${value.slice(0, MAX_FIELD_LENGTH)}...`;
}
