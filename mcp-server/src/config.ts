import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true });

export type Config = {
  githubToken: string;
  googleApiKey: string;
  geminiModel: string;
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
};

type Env = Record<string, string | undefined>;

function required(env: Env, key: string, missing: string[]): string {
  const value = env[key]?.trim();
  if (!value) missing.push(key);
  return value ?? "";
}

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

/** Parses and validates configuration, reporting every problem at once. */
export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const errors: string[] = [];

  const githubToken = required(env, "GITHUB_TOKEN", missing);
  const googleApiKey = required(env, "GOOGLE_API_KEY", missing);
  const smtpUser = required(env, "SMTP_USER", missing);
  const smtpPass = required(env, "SMTP_PASS", missing);
  const mailTo = required(env, "MAIL_TO", missing)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const smtpPort = int(env, "SMTP_PORT", 465, 1, errors);

  const config: Config = {
    githubToken,
    googleApiKey,
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
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
    // Default matches Gemini's free tier; raise it if you have a paid key.
    llmRequestsPerMinute: int(env, "LLM_RPM", 5, 1, errors),
    llmBatchSize: int(env, "LLM_BATCH_SIZE", 8, 1, errors),
  };

  if (missing.length) errors.unshift(`Missing required env vars: ${missing.join(", ")}`);
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  return config;
}
