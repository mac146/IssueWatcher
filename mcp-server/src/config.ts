import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true });

export type ProviderConfig = {
  /** Which wire protocol to speak. Most hosted LLMs are OpenAI-compatible. */
  kind: "gemini" | "openai-compatible" | "anthropic";
  /** Short label used in logs and LLM_PROVIDERS, e.g. "groq". */
  name: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
};

export type Config = {
  githubToken: string;
  /** Tried in order; when one is rate-limited or down the next takes over. Empty = no AI. */
  llmProviders: ProviderConfig[];
  /** Fill missing AI summaries with a plain excerpt of the issue body. */
  extractiveFallback: boolean;
  redisUrl: string | null;
  cacheTtlDays: number;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  mailFrom: string;
  mailTo: string[];
  pollIntervalMs: number;
  stateFile: string;
  runOnce: boolean;
  maxIssuesPerEmail: number;
  maxBodyChars: number;
  llmConcurrency: number;
  llmRequestsPerMinute: number;
  llmBatchSize: number;
  dependencyScan: boolean;
  dependencyRepos: string[];
  maxDependencyRepos: number;
  maxDependencies: number;
  minSummaryScore: number;
  scoringMode: "consumer" | "contributor" | "both";
  ignoreRepos: string[];
  ignoreLabels: string[];
  dryRun: boolean;
  previewPerRepo: number;
};

type Env = Record<string, string | undefined>;

type Preset = {
  kind: ProviderConfig["kind"];
  /** Env vars checked, in order, for the API key. */
  keyVars: string[];
  modelVar: string;
  defaultModel: string;
  baseUrlVar?: string;
  defaultBaseUrl?: string;
};

/**
 * Default models and endpoints change over time; every one can be overridden
 * through its *_MODEL / *_BASE_URL variable.
 */
const PRESETS: Record<string, Preset> = {
  gemini: { kind: "gemini", keyVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], modelVar: "GEMINI_MODEL", defaultModel: "gemini-2.5-flash" },
  openai: {
    kind: "openai-compatible",
    keyVars: ["OPENAI_API_KEY"],
    modelVar: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    baseUrlVar: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  anthropic: { kind: "anthropic", keyVars: ["ANTHROPIC_API_KEY"], modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-haiku-5-5" },
  groq: {
    kind: "openai-compatible",
    keyVars: ["GROQ_API_KEY"],
    modelVar: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  openrouter: {
    kind: "openai-compatible",
    keyVars: ["OPENROUTER_API_KEY"],
    modelVar: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
};

/** Auto-detection order when LLM_PROVIDERS is not set. */
const AUTO_ORDER = ["gemini", "openai", "anthropic", "groq", "openrouter", "custom"];

export const KNOWN_PROVIDERS = [...AUTO_ORDER];

function required(env: Env, key: string, missing: string[]): string {
  const value = env[key]?.trim();
  if (!value) missing.push(key);
  return value ?? "";
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function int(env: Env, key: string, fallback: number, min: number, errors: string[]): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${key} must be an integer >= ${min} (got "${raw}")`);
    return fallback;
  }
  return n;
}

const firstSet = (env: Env, keys: string[]) => keys.map((k) => env[k]?.trim()).find(Boolean);

/** The user's own OpenAI-compatible endpoint, e.g. Ollama or LM Studio at http://localhost:11434/v1. */
function customProvider(env: Env, explicit: boolean, errors: string[]): ProviderConfig | null {
  const baseUrl = env.CUSTOM_LLM_BASE_URL?.trim();
  const model = env.CUSTOM_LLM_MODEL?.trim();
  if (!baseUrl) {
    if (explicit) errors.push("LLM_PROVIDERS includes custom, so CUSTOM_LLM_BASE_URL is required");
    return null;
  }
  if (!model) {
    errors.push("CUSTOM_LLM_MODEL is required when CUSTOM_LLM_BASE_URL is set");
    return null;
  }
  return { kind: "openai-compatible", name: "custom", apiKey: env.CUSTOM_LLM_API_KEY?.trim() ?? "", model, baseUrl };
}

/**
 * Chooses the AI providers. With LLM_PROVIDERS unset, every provider that has
 * a key is used, in AUTO_ORDER. With it set, exactly those are used in the
 * order given ("none" disables AI). Having no provider is valid: the app then
 * falls back to plain excerpts.
 */
export function resolveProviders(env: Env, errors: string[]): ProviderConfig[] {
  const requested = list(env.LLM_PROVIDERS).map((s) => s.toLowerCase());
  if (requested.includes("none")) return [];

  const names = requested.length ? requested : AUTO_ORDER;
  const out: ProviderConfig[] = [];

  for (const name of names) {
    if (name === "custom") {
      const custom = customProvider(env, requested.length > 0, errors);
      if (custom) out.push(custom);
      continue;
    }
    const preset = PRESETS[name];
    if (!preset) {
      errors.push(`Unknown LLM provider "${name}" (known: ${KNOWN_PROVIDERS.join(", ")}, none)`);
      continue;
    }
    const apiKey = firstSet(env, preset.keyVars);
    if (!apiKey) {
      if (requested.length) errors.push(`LLM_PROVIDERS includes ${name}, so ${preset.keyVars[0]} is required`);
      continue;
    }
    out.push({
      kind: preset.kind,
      name,
      apiKey,
      model: env[preset.modelVar]?.trim() || preset.defaultModel,
      baseUrl: (preset.baseUrlVar && env[preset.baseUrlVar]?.trim()) || preset.defaultBaseUrl,
    });
  }
  return out;
}

/** Parses and validates configuration, reporting every problem at once. */
export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const errors: string[] = [];

  const githubToken = required(env, "GITHUB_TOKEN", missing);
  // Dry-run only reads GitHub, so it needs no mail settings.
  const dryRun = env.DRY_RUN === "true";
  const sendingKey = (key: string) => (dryRun ? env[key]?.trim() ?? "" : required(env, key, missing));
  const smtpUser = sendingKey("SMTP_USER");
  const smtpPass = sendingKey("SMTP_PASS");
  const mailTo = list(sendingKey("MAIL_TO"));

  const scoringMode = (env.SCORING_MODE?.trim().toLowerCase() || "both") as Config["scoringMode"];
  if (!["consumer", "contributor", "both"].includes(scoringMode)) {
    errors.push(`SCORING_MODE must be consumer, contributor or both (got "${env.SCORING_MODE}")`);
  }

  const smtpPort = int(env, "SMTP_PORT", 465, 1, errors);

  const config: Config = {
    githubToken,
    llmProviders: resolveProviders(env, errors),
    extractiveFallback: env.EXTRACTIVE_FALLBACK !== "false",
    redisUrl: env.REDIS_URL?.trim() || null,
    cacheTtlDays: int(env, "CACHE_TTL_DAYS", 30, 1, errors),
    smtp: {
      host: env.SMTP_HOST?.trim() || "smtp.gmail.com",
      port: smtpPort,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : smtpPort === 465,
      user: smtpUser,
      pass: smtpPass,
    },
    mailFrom: env.MAIL_FROM?.trim() || smtpUser,
    mailTo,
    // Floor of one minute so a typo can't hammer the GitHub API.
    pollIntervalMs: int(env, "WATCH_INTERVAL", 1_800_000, 60_000, errors),
    stateFile: path.resolve(env.STATE_FILE?.trim() || "data/state.json"),
    runOnce: env.RUN_ONCE === "true",
    maxIssuesPerEmail: int(env, "MAX_ISSUES_PER_EMAIL", 50, 1, errors),
    maxBodyChars: int(env, "MAX_BODY_CHARS", 4000, 100, errors),
    llmConcurrency: int(env, "LLM_CONCURRENCY", 3, 1, errors),
    // Default is conservative for free tiers; raise it if you have a paid key.
    llmRequestsPerMinute: int(env, "LLM_RPM", 5, 1, errors),
    llmBatchSize: int(env, "LLM_BATCH_SIZE", 8, 1, errors),
    dependencyScan: env.DEPENDENCY_SCAN !== "false",
    dependencyRepos: list(env.DEPENDENCY_REPOS),
    maxDependencyRepos: int(env, "MAX_DEPENDENCY_REPOS", 20, 1, errors),
    maxDependencies: int(env, "MAX_DEPENDENCIES", 100, 1, errors),
    scoringMode,
    minSummaryScore: int(env, "MIN_SUMMARY_SCORE", 30, 0, errors),
    ignoreRepos: list(env.IGNORE_REPOS),
    ignoreLabels: list(env.IGNORE_LABELS),
    dryRun,
    previewPerRepo: int(env, "PREVIEW_PER_REPO", 3, 1, errors),
  };

  if (missing.length) errors.unshift(`Missing required env vars: ${missing.join(", ")}`);
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  return config;
}
