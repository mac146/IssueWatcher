import os from "node:os";
import path from "node:path";
import type { ScoringMode } from "../scoring/score.js";

export type McpSettings = {
  /** null when none is set; the server still starts and tells the user how to fix it. */
  githubToken: string | null;
  githubApiUrl: string;
  npmUrl: string;
  pypiUrl: string;
  mode: ScoringMode;
  dependencyScan: boolean;
  dependencyRepos: string[];
  maxDependencyRepos: number;
  maxDependencies: number;
  ignoreRepos: string[];
  ignoreLabels: string[];
  /** Where the dependency cache lives. */
  cacheDir: string;
  concurrency: number;
  budgetMs: number;
  cacheTtlMs: number;
  /** Load repos and recent issues in the background at startup so the first question is fast. */
  prefetch: boolean;
};

type Env = Record<string, string | undefined>;

const text = (env: Env, key: string) => env[key]?.trim() || undefined;
const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Reads settings from the environment. Invalid values never crash the server (a client would only
 * show "server disconnected"); they fall back to defaults and are returned as `problems`.
 * An empty string counts as unset, which is how clients and GitHub Actions pass blank settings.
 */
export function loadMcpSettings(env: Env = process.env): { settings: McpSettings; problems: string[] } {
  const problems: string[] = [];

  const int = (key: string, fallback: number, min: number, max: number): number => {
    const raw = text(env, key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be a whole number from ${min} to ${max} (got "${raw}"); using ${fallback}.`);
      return fallback;
    }
    return n;
  };

  const modeRaw = text(env, "SCORING_MODE")?.toLowerCase();
  let mode: ScoringMode = "both";
  if (modeRaw !== undefined) {
    if (modeRaw === "consumer" || modeRaw === "contributor" || modeRaw === "both") mode = modeRaw;
    else problems.push(`SCORING_MODE must be consumer, contributor or both (got "${modeRaw}"); using both.`);
  }

  const settings: McpSettings = {
    githubToken: text(env, "GITHUB_TOKEN") ?? text(env, "GH_TOKEN") ?? null,
    githubApiUrl: text(env, "ISSUEWATCHER_GITHUB_API_URL") ?? "https://api.github.com",
    npmUrl: text(env, "ISSUEWATCHER_NPM_URL") ?? "https://registry.npmjs.org",
    pypiUrl: text(env, "ISSUEWATCHER_PYPI_URL") ?? "https://pypi.org",
    mode,
    dependencyScan: env.DEPENDENCY_SCAN?.trim().toLowerCase() !== "false",
    dependencyRepos: list(env.DEPENDENCY_REPOS),
    maxDependencyRepos: int("MAX_DEPENDENCY_REPOS", 20, 1, 100),
    maxDependencies: int("MAX_DEPENDENCIES", 100, 1, 500),
    ignoreRepos: list(env.IGNORE_REPOS),
    ignoreLabels: list(env.IGNORE_LABELS),
    cacheDir: path.resolve(text(env, "ISSUEWATCHER_CACHE_DIR") ?? path.join(os.homedir(), ".issuewatcher")),
    concurrency: int("ISSUEWATCHER_CONCURRENCY", 8, 1, 32),
    budgetMs: int("ISSUEWATCHER_BUDGET_MS", 20_000, 1_000, 120_000),
    cacheTtlMs: int("ISSUEWATCHER_CACHE_TTL_MS", 600_000, 0, 86_400_000),
    prefetch: env.ISSUEWATCHER_PREFETCH?.trim().toLowerCase() !== "false",
  };
  return { settings, problems };
}

export const SETUP_HELP =
  "IssueWatcher needs a GitHub personal access token to read your starred repositories. " +
  "Create one at https://github.com/settings/personal-access-tokens/new (read-only access is enough), " +
  "then set it as the GITHUB_TOKEN environment variable for this server and restart your AI app. " +
  "Run `npx issuewatcher-mcp --check` in a terminal to test the setup.";
