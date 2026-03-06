import type { ProviderProfile } from "../providers/compatibility-profile.js";
import { getWorkspaceRoot } from "../../runtime/workspace-context.js";

export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
  maxTokens?: number;
};

export type RuntimeConfig = {
  model: OpenAICompatibleConfig;
  workspaceRoot: string;
  activeSkillIds: string[];
  globalPolicy: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations: number;
  debugModelMessages: boolean;
  gatewayPort: number;
};

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  return {
    model: {
      baseURL: requireEnv(env, "OPENAI_BASE_URL"),
      apiKey: env.OPENAI_API_KEY ?? "dummy",
      model: requireEnv(env, "OPENAI_MODEL"),
      profile: parseProfile(env.OPENAI_COMPAT_PROFILE),
      temperature: parseOptionalNumber(env.OPENAI_TEMPERATURE),
      maxTokens: parseOptionalNumber(env.OPENAI_MAX_TOKENS),
    },
    workspaceRoot: env.MALIKRAW_WORKSPACE?.trim() || getWorkspaceRoot(),
    activeSkillIds: parseList(env.ACTIVE_SKILLS ?? "workspace_operator"),
    globalPolicy: env.GLOBAL_AGENT_POLICY?.trim()
      ?? "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
    stateSummary: emptyToUndefined(env.STATE_SUMMARY),
    memorySummary: emptyToUndefined(env.MEMORY_SUMMARY),
    maxIterations: parseOptionalNumber(env.MAX_ITERATIONS) ?? 8,
    debugModelMessages: parseBoolean(env.DEBUG_MODEL_MESSAGES) ?? false,
    gatewayPort: parseOptionalNumber(env.GATEWAY_PORT) ?? 5050,
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${key}.`);
  }

  return value;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received "${value}".`);
  }

  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }

  throw new Error(`Expected a boolean-like value, received "${value}".`);
}

function parseProfile(value: string | undefined): ProviderProfile | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "openai" || value === "deepseek" || value === "qwen") {
    return value;
  }

  throw new Error(`Unsupported OPENAI_COMPAT_PROFILE "${value}". Expected "openai", "deepseek", or "qwen".`);
}
