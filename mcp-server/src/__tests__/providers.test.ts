import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import {
  AuthError,
  FallbackSummarizer,
  LlmSummarizer,
  RateLimitError,
  type LlmProvider,
} from "../llm/provider.js";
import { AnthropicProvider, OpenAICompatibleProvider, classifyHttpError } from "../llm/providers.js";
import { QuotaExhaustedError, RateLimiter, parseBatchResponse, type Summarizer } from "../llm/summarizer.js";
import { buildSummarizer } from "../llm/factory.js";
import { issue } from "./helpers.js";

const batch = [issue("a/b", 1), issue("a/b", 2)];
const goodJson = JSON.stringify([
  { id: 1, summary: "one", fix: "f1" },
  { id: 2, summary: "two", fix: "f2" },
]);
const instant = new RateLimiter(10_000);
const noSleep = async () => undefined;

/** Fake axios whose post() replays queued outcomes and records the requests. */
function fakeHttp(outcomes: Array<{ data: unknown } | { status: number; data?: unknown; headers?: object }>) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const client = {
    post: async (url: string, body: unknown, cfg?: { headers?: Record<string, string> }) => {
      calls.push({ url, body, headers: cfg?.headers ?? {} });
      const o = outcomes[i++]!;
      if ("status" in o) {
        throw Object.assign(new Error(`HTTP ${o.status}`), {
          isAxiosError: true,
          response: { status: o.status, data: o.data, headers: o.headers ?? {} },
        });
      }
      return { data: o.data };
    },
  } as unknown as AxiosInstance;
  return { client, calls };
}

test("parseBatchResponse accepts fenced JSON, wrapped objects and surrounding text", () => {
  const expected = ["Summary: one\n\nPossible fix: f1", "Summary: two\n\nPossible fix: f2"];
  assert.deepEqual(parseBatchResponse("```json\n" + goodJson + "\n```", 2), expected);
  assert.deepEqual(parseBatchResponse(JSON.stringify({ results: JSON.parse(goodJson) }), 2), expected);
  assert.deepEqual(parseBatchResponse(`Sure! Here you go:\n${goodJson}\nHope that helps`, 2), expected);
});

test("OpenAI-compatible provider sends the chat-completions request and reads the reply", async () => {
  const { client, calls } = fakeHttp([{ data: { choices: [{ message: { content: goodJson } }] } }]);
  const p = new OpenAICompatibleProvider({ name: "groq", baseUrl: "https://api.groq.com/openai/v1/", model: "m", apiKey: "sk", client });
  assert.equal(await p.complete("hello"), goodJson);
  assert.equal(calls[0]!.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.deepEqual((calls[0]!.body as { messages: unknown }).messages, [{ role: "user", content: "hello" }]);
  assert.equal(calls[0]!.headers.Authorization, "Bearer sk");
  assert.equal(p.name, "groq:m");
});

test("a keyless local endpoint sends no Authorization header", async () => {
  const { client, calls } = fakeHttp([{ data: { choices: [{ message: { content: "x" } }] } }]);
  await new OpenAICompatibleProvider({ name: "custom", baseUrl: "http://localhost:11434/v1", model: "m", client }).complete("p");
  assert.equal(calls[0]!.headers.Authorization, undefined);
});

test("Anthropic provider uses the messages API headers and reads the text block", async () => {
  const { client, calls } = fakeHttp([{ data: { content: [{ type: "text", text: goodJson }] } }]);
  const p = new AnthropicProvider({ model: "claude-haiku-5-5", apiKey: "ak", client });
  assert.equal(await p.complete("hi"), goodJson);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0]!.headers["x-api-key"], "ak");
  assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal((calls[0]!.body as { model: string }).model, "claude-haiku-5-5");
});

test("HTTP errors are classified: 401 auth, 429 rate limit, out-of-credit as long wait", () => {
  const http = (status: number, data?: unknown, headers: object = {}) =>
    Object.assign(new Error("x"), { isAxiosError: true, response: { status, data, headers } });

  assert.ok(classifyHttpError(http(401, { error: { message: "bad key" } })) instanceof AuthError);

  const burst = classifyHttpError(http(429, { error: { message: "Rate limit. Please try again in 7.5s" } })) as RateLimitError;
  assert.ok(burst instanceof RateLimitError);
  assert.equal(burst.retryAfterMs, 8_500);

  const header = classifyHttpError(http(429, {}, { "retry-after": "12" })) as RateLimitError;
  assert.equal(header.retryAfterMs, 12_000);

  const broke = classifyHttpError(http(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } })) as RateLimitError;
  assert.ok(broke.retryAfterMs >= 86_400_000);

  const server = classifyHttpError(http(503, {}));
  assert.ok(server instanceof Error && !(server instanceof RateLimitError) && !(server instanceof AuthError));
});

function provider(outcomes: Array<string | Error>): LlmProvider & { calls: number } {
  let i = 0;
  const p = {
    name: "fake",
    calls: 0,
    async complete() {
      p.calls++;
      const o = outcomes[Math.min(i++, outcomes.length - 1)]!;
      if (o instanceof Error) throw o;
      return o;
    },
  };
  return p;
}

test("LlmSummarizer parses a good reply", async () => {
  const s = new LlmSummarizer(provider([goodJson]), 4000, instant, noSleep);
  assert.deepEqual(await s.summarizeBatch(batch), ["Summary: one\n\nPossible fix: f1", "Summary: two\n\nPossible fix: f2"]);
});

test("LlmSummarizer waits out a short rate limit and retries", async () => {
  const waits: number[] = [];
  const p = provider([new RateLimitError("slow down", 5_000), goodJson]);
  const s = new LlmSummarizer(p, 4000, instant, async (ms) => void waits.push(ms));
  await s.summarizeBatch(batch);
  assert.deepEqual(waits, [5_000]);
  assert.equal(p.calls, 2);
});

test("LlmSummarizer turns a long rate limit into QuotaExhaustedError without retrying", async () => {
  const p = provider([new RateLimitError("daily", 3_600_000 * 15)]);
  await assert.rejects(new LlmSummarizer(p, 4000, instant, noSleep).summarizeBatch(batch), QuotaExhaustedError);
  assert.equal(p.calls, 1);
});

test("LlmSummarizer treats a bad key as unavailable, immediately", async () => {
  const p = provider([new AuthError("invalid key")]);
  await assert.rejects(new LlmSummarizer(p, 4000, instant, noSleep).summarizeBatch(batch), QuotaExhaustedError);
  assert.equal(p.calls, 1);
});

test("LlmSummarizer retries transient errors, then gives up", async () => {
  const p = provider([new Error("503")]);
  await assert.rejects(new LlmSummarizer(p, 4000, instant, noSleep).summarizeBatch(batch), /503/);
  assert.equal(p.calls, 4);
});

const named = (name: string, impl: Summarizer["summarizeBatch"]) => ({ name, summarizer: { summarizeBatch: impl } });

test("fallback moves to the next provider when one is out of quota, and remembers it", async () => {
  let aCalls = 0;
  let clock = 0;
  const f = new FallbackSummarizer(
    [
      named("a", async () => (aCalls++, Promise.reject(new QuotaExhaustedError("a spent", 10 * 60_000)))),
      named("b", async (b) => b.map(() => "from b")),
    ],
    () => clock,
  );
  assert.deepEqual(await f.summarizeBatch(batch), ["from b", "from b"]);
  await f.summarizeBatch(batch);
  assert.equal(aCalls, 1); // skipped while it is known to be exhausted

  clock += 11 * 60_000;
  await f.summarizeBatch(batch);
  assert.equal(aCalls, 2); // probed again after the wait
});

test("fallback also moves on after an ordinary failure", async () => {
  const f = new FallbackSummarizer([
    named("a", async () => Promise.reject(new Error("bad json"))),
    named("b", async (b) => b.map(() => "ok")),
  ]);
  assert.deepEqual(await f.summarizeBatch(batch), ["ok", "ok"]);
});

test("when every provider is exhausted the fallback reports quota exhaustion", async () => {
  const spent = (n: string) => named(n, async () => Promise.reject(new QuotaExhaustedError(`${n} spent`)));
  await assert.rejects(new FallbackSummarizer([spent("a"), spent("b")]).summarizeBatch(batch), QuotaExhaustedError);
});

test("buildSummarizer: no providers means no AI, one is used directly, several fall back", async () => {
  const base = { maxBodyChars: 4000, llmRequestsPerMinute: 5 };
  const none = buildSummarizer({ ...base, llmProviders: [] });
  assert.deepEqual(none.providerNames, []);
  assert.deepEqual(await none.summarizer.summarizeBatch(batch), [null, null]);

  const many = buildSummarizer({
    ...base,
    llmProviders: [
      { kind: "gemini", name: "gemini", apiKey: "k", model: "gemini-2.5-flash" },
      { kind: "openai-compatible", name: "groq", apiKey: "k", model: "m", baseUrl: "https://api.groq.com/openai/v1" },
      { kind: "anthropic", name: "anthropic", apiKey: "k", model: "claude-haiku-5-5" },
    ],
  });
  assert.deepEqual(many.providerNames, ["gemini:gemini-2.5-flash", "groq:m", "anthropic:claude-haiku-5-5"]);
  assert.ok(many.summarizer instanceof FallbackSummarizer);
});
