import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QuotaExhaustedError,
  RateLimiter,
  parseBatchResponse,
  parseRetryDelayMs,
  summarizeIssues,
  type Summarizer,
} from "../llm/summarizer.js";
import { issue } from "./helpers.js";

test("rate limiter spaces requests 60s/rpm apart", async () => {
  const t = 0; // fake clock stays put: all three acquire() calls are concurrent
  const waits: number[] = [];
  const limiter = new RateLimiter(5, () => t, async (ms) => {
    waits.push(ms);
  });
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.deepEqual(waits, [12_000, 24_000]);
});

test("parses Gemini's requested retry delay from a 429", () => {
  const err = new Error("[429 Too Many Requests] quota. Please retry in 53.64s.");
  assert.equal(parseRetryDelayMs(err), 54_640);
  assert.equal(parseRetryDelayMs(new Error("[429] no hint")), 30_000);
  assert.equal(parseRetryDelayMs(new Error("[500 Server Error]")), null);
});

const issues = (n: number) => Array.from({ length: n }, (_, i) => issue("a/b", i + 1));
const echo: Summarizer = { summarizeBatch: async (b) => b.map((i) => `s${i.number}`) };

test("parses retry delays that include hours and minutes", () => {
  const ms = parseRetryDelayMs(new Error("[429] Please retry in 14h56m42.9s."))!;
  assert.ok(ms >= 53_802_900 && ms <= 53_805_000, `got ${ms}`);
});

test("parseBatchResponse maps ids back and nulls invalid entries", () => {
  const json = JSON.stringify([
    { id: 2, summary: "two", fix: "f2" },
    { id: 9, summary: "out of range", fix: "x" },
    { id: 1, summary: "  ", fix: "x" },
    "junk",
  ]);
  const out = parseBatchResponse(json, 3);
  assert.equal(out[0], null);
  assert.equal(out[1], "Summary: two\n\nPossible fix: f2");
  assert.equal(out[2], null);
});

test("parseBatchResponse rejects non-array payloads", () => {
  assert.throws(() => parseBatchResponse("{}", 1));
  assert.throws(() => parseBatchResponse("not json", 1));
});

test("issues are sent in batches of the configured size", async () => {
  const sizes: number[] = [];
  const s: Summarizer = {
    summarizeBatch: async (b) => {
      sizes.push(b.length);
      return b.map(() => "ok");
    },
  };
  const out = await summarizeIssues(issues(7), s, { concurrency: 1, limit: 100, batchSize: 3 });
  assert.deepEqual(sizes, [3, 3, 1]);
  assert.ok(out.every((o) => o.summary === "ok"));
});

test("issues beyond the limit are listed without a summary", async () => {
  const out = await summarizeIssues(issues(5), echo, { concurrency: 2, limit: 2, batchSize: 2 });
  assert.deepEqual(out.map((o) => o.summary), ["s1", "s2", null, null, null]);
});

test("a failed batch falls back to issue-by-issue", async () => {
  const s: Summarizer = {
    summarizeBatch: async (b) => {
      if (b.length > 1) throw new Error("bad json");
      return b.map((i) => `s${i.number}`);
    },
  };
  const out = await summarizeIssues(issues(3), s, { concurrency: 1, limit: 10, batchSize: 3 });
  assert.deepEqual(out.map((o) => o.summary), ["s1", "s2", "s3"]);
});

test("quota exhaustion stops further calls after one attempt", async () => {
  let calls = 0;
  const s: Summarizer = {
    summarizeBatch: async () => {
      calls++;
      throw new QuotaExhaustedError("daily quota");
    },
  };
  const out = await summarizeIssues(issues(20), s, { concurrency: 1, limit: 100, batchSize: 2 });
  assert.equal(calls, 1);
  assert.equal(out.length, 20);
  assert.ok(out.every((o) => o.summary === null));
});

test("concurrency is bounded", async () => {
  let active = 0;
  let peak = 0;
  const s: Summarizer = {
    summarizeBatch: async (b) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return b.map(() => "ok");
    },
  };
  await summarizeIssues(issues(8), s, { concurrency: 2, limit: 8, batchSize: 1 });
  assert.equal(peak, 2);
});
