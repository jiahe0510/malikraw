export type OpenAICompatibleConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
};

export type AppConfig = {
  model: OpenAICompatibleConfig;
  activeSkillIds: string[];
  globalPolicy: string;
  userRequest: string;
  stateSummary?: string;
  memorySummary?: string;
  maxIterations: number;
};

export function loadAppConfig(env: Record<string, string | undefined>, argv: readonly string[]): AppConfig {
  const userRequest = argv.join(" ").trim() || env.USER_REQUEST?.trim();
  if (!userRequest) {
    throw new Error("Missing user request. Pass it as CLI args or set USER_REQUEST.");
  }

  return {
    model: {
      baseURL: requireEnv(env, "OPENAI_BASE_URL"),
      apiKey: env.OPENAI_API_KEY ?? "dummy",
      model: requireEnv(env, "OPENAI_MODEL"),
      temperature: parseOptionalNumber(env.OPENAI_TEMPERATURE),
      maxTokens: parseOptionalNumber(env.OPENAI_MAX_TOKENS),
    },
    activeSkillIds: parseList(env.ACTIVE_SKILLS ?? "triage_incident"),
    globalPolicy: env.GLOBAL_AGENT_POLICY?.trim()
      ?? "Operate as a careful agent runtime. Prefer using tools over guessing. Be explicit about uncertainty.",
    userRequest,
    stateSummary: emptyToUndefined(env.STATE_SUMMARY),
    memorySummary: emptyToUndefined(env.MEMORY_SUMMARY),
    maxIterations: parseOptionalNumber(env.MAX_ITERATIONS) ?? 8,
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
