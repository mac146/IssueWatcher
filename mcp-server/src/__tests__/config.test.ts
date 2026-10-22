import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";

const base = {
  GITHUB_TOKEN: "g",
  SMTP_USER: "u@x.com",
  SMTP_PASS: "p",
  MAIL_TO: "a@x.com, b@x.com",
};

test("applies defaults and splits recipients", () => {
  const c = loadConfig(base);
  assert.deepEqual(c.mailTo, ["a@x.com", "b@x.com"]);
  assert.equal(c.pollIntervalMs, 1_800_000);
  assert.equal(c.smtp.secure, true);
  assert.equal(c.redisUrl, null);
  assert.equal(c.extractiveFallback, true);
});

test("reports all missing vars at once", () => {
  assert.throws(() => loadConfig({}), /GITHUB_TOKEN.*SMTP_USER.*SMTP_PASS.*MAIL_TO/s);
});

test("rejects a too-small interval", () => {
  assert.throws(() => loadConfig({ ...base, WATCH_INTERVAL: "100" }), /WATCH_INTERVAL/);
});

test("no AI key is valid: the app runs on excerpts", () => {
  assert.deepEqual(loadConfig(base).llmProviders, []);
});

test("providers with keys are auto-detected in a fixed order", () => {
  const c = loadConfig({ ...base, GROQ_API_KEY: "k1", GOOGLE_API_KEY: "k2", OPENAI_API_KEY: "k3" });
  assert.deepEqual(c.llmProviders.map((p) => p.name), ["gemini", "openai", "groq"]);
  assert.equal(c.llmProviders[2]!.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(c.llmProviders[0]!.kind, "gemini");
});

test("GEMINI_API_KEY works as an alias and models can be overridden", () => {
  const c = loadConfig({ ...base, GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-2.5-flash-lite" });
  assert.equal(c.llmProviders[0]!.apiKey, "k");
  assert.equal(c.llmProviders[0]!.model, "gemini-2.5-flash-lite");
});

test("LLM_PROVIDERS sets the order explicitly and requires the keys it names", () => {
  const c = loadConfig({ ...base, LLM_PROVIDERS: "groq, gemini", GROQ_API_KEY: "a", GOOGLE_API_KEY: "b", OPENAI_API_KEY: "c" });
  assert.deepEqual(c.llmProviders.map((p) => p.name), ["groq", "gemini"]);
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDERS: "openai" }), /OPENAI_API_KEY is required/);
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDERS: "nope" }), /Unknown LLM provider "nope"/);
});

test("LLM_PROVIDERS=none disables AI even when keys exist", () => {
  assert.deepEqual(loadConfig({ ...base, LLM_PROVIDERS: "none", GOOGLE_API_KEY: "k" }).llmProviders, []);
});

test("a custom OpenAI-compatible endpoint (e.g. Ollama) needs a base URL and model but no key", () => {
  const c = loadConfig({ ...base, CUSTOM_LLM_BASE_URL: "http://localhost:11434/v1", CUSTOM_LLM_MODEL: "llama3.2" });
  assert.deepEqual(c.llmProviders.map((p) => [p.name, p.apiKey, p.model]), [["custom", "", "llama3.2"]]);
  assert.throws(() => loadConfig({ ...base, CUSTOM_LLM_BASE_URL: "http://x/v1" }), /CUSTOM_LLM_MODEL/);
});

test("dry run needs no mail settings", () => {
  assert.doesNotThrow(() => loadConfig({ GITHUB_TOKEN: "g", DRY_RUN: "true" }));
});

test("empty strings, which is how GitHub Actions passes unset secrets and variables, count as unset", () => {
  const blank = Object.fromEntries(
    [
      "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "REDIS_URL",
      "LLM_PROVIDERS", "GEMINI_MODEL", "OPENAI_MODEL", "ANTHROPIC_MODEL", "GROQ_MODEL", "OPENROUTER_MODEL",
      "SCORING_MODE", "MIN_SUMMARY_SCORE", "IGNORE_REPOS", "IGNORE_LABELS", "DEPENDENCY_SCAN", "DEPENDENCY_REPOS",
      "MAX_ISSUES_PER_EMAIL", "DRY_RUN", "SMTP_PORT", "SMTP_SECURE", "MAIL_FROM", "CUSTOM_LLM_BASE_URL",
    ].map((k) => [k, ""]),
  );
  const c = loadConfig({ ...base, ...blank, RUN_ONCE: "true" });
  assert.deepEqual(c.llmProviders, []);
  assert.equal(c.redisUrl, null);
  assert.equal(c.scoringMode, "both");
  assert.equal(c.minSummaryScore, 30);
  assert.equal(c.dependencyScan, true);
  assert.equal(c.dryRun, false);
  assert.equal(c.smtp.port, 465);
  assert.equal(c.mailFrom, "u@x.com");

  // One real key among the blanks is still picked up.
  assert.deepEqual(loadConfig({ ...base, ...blank, GROQ_API_KEY: "k" }).llmProviders.map((p) => p.name), ["groq"]);
});

test("the summary threshold defaults per scoring mode and an explicit value wins", () => {
  assert.equal(loadConfig({ ...base, SCORING_MODE: "contributor" }).minSummaryScore, 45);
  assert.equal(loadConfig({ ...base, SCORING_MODE: "consumer" }).minSummaryScore, 30);
  assert.equal(loadConfig(base).minSummaryScore, 30);
  assert.equal(loadConfig({ ...base, SCORING_MODE: "contributor", MIN_SUMMARY_SCORE: "20" }).minSummaryScore, 20);
});
