import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCache, RedisCache, summarizeCached, summaryKey, type RedisLike } from "../llm/cache.js";
import { excerpt } from "../llm/extractive.js";
import type { Summarizer } from "../llm/summarizer.js";
import { issue } from "./helpers.js";

const opts = { concurrency: 2, batchSize: 5, maxBodyChars: 4000, ttlSeconds: 60 };
const item = (n: number, extra = {}) => ({ issue: issue("a/b", n, extra), score: n });

function countingSummarizer(fail = false) {
  const asked: number[] = [];
  const s: Summarizer = {
    summarizeBatch: async (b) => {
      asked.push(...b.map((i) => i.number));
      if (fail) throw new Error("llm down");
      return b.map((i) => `sum${i.number}`);
    },
  };
  return { s, asked };
}

test("summaryKey changes when the issue content changes, not otherwise", () => {
  const a = summaryKey(issue("a/b", 1), 4000);
  assert.equal(a, summaryKey(issue("a/b", 1), 4000));
  assert.notEqual(a, summaryKey(issue("a/b", 2), 4000));
  assert.notEqual(a, summaryKey(issue("a/b", 1, { title: "edited title of the issue" }), 4000));
  assert.notEqual(a, summaryKey(issue("a/b", 1, { body: "different body that is long enough" }), 4000));
  assert.notEqual(a, summaryKey(issue("c/d", 1), 4000));
});

test("only cache misses are sent to the model, and results are cached", async () => {
  const cache = new MemoryCache();
  const first = countingSummarizer();
  const out1 = await summarizeCached([item(1), item(2)], first.s, cache, opts);
  assert.deepEqual(out1.map((o) => o.summary), ["sum1", "sum2"]);

  const second = countingSummarizer();
  const out2 = await summarizeCached([item(2), item(3), item(1)], second.s, cache, opts);
  assert.deepEqual(second.asked, [3]); // 1 and 2 came from the cache
  assert.deepEqual(out2.map((o) => o.summary), ["sum2", "sum3", "sum1"]); // order and extra fields preserved
  assert.deepEqual(out2.map((o) => o.score), [2, 3, 1]);
});

test("failures are not cached, so they are retried next time", async () => {
  const cache = new MemoryCache();
  const down = countingSummarizer(true);
  const out = await summarizeCached([item(1)], down.s, cache, opts);
  assert.equal(out[0]!.summary, null);

  const up = countingSummarizer();
  assert.equal((await summarizeCached([item(1)], up.s, cache, opts))[0]!.summary, "sum1");
});

test("cached summaries are still served when the model is unavailable", async () => {
  const cache = new MemoryCache();
  await summarizeCached([item(1)], countingSummarizer().s, cache, opts);
  const out = await summarizeCached([item(1), item(2)], countingSummarizer(true).s, cache, opts);
  assert.deepEqual(out.map((o) => o.summary), ["sum1", null]);
});

test("memory cache entries expire", async () => {
  let now = 0;
  const cache = new MemoryCache(() => now);
  await cache.set("k", "v", 10);
  assert.equal(await cache.get("k"), "v");
  now = 10_001;
  assert.equal(await cache.get("k"), null);
});

function fakeRedis(fail = false): RedisLike & { store: Map<string, { value: string; ttl: number }> } {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    get: async (k) => {
      if (fail) throw new Error("ECONNREFUSED");
      return store.get(k)?.value ?? null;
    },
    set: async (k, value, _mode, ttl) => {
      if (fail) throw new Error("ECONNREFUSED");
      store.set(k, { value, ttl });
    },
    quit: async () => "OK",
  };
}

test("redis cache stores values with an expiry", async () => {
  const redis = fakeRedis();
  const cache = new RedisCache(redis);
  await cache.set("k", "v", 123);
  assert.equal(await cache.get("k"), "v");
  assert.equal(redis.store.get("k")!.ttl, 123);
  assert.equal(await cache.get("missing"), null);
});

test("a failing Redis is a cache miss, never an error", async () => {
  const cache = new RedisCache(fakeRedis(true));
  assert.equal(await cache.get("k"), null);
  await assert.doesNotReject(cache.set("k", "v", 10));
  await assert.doesNotReject(cache.close());

  const out = await summarizeCached([item(1)], countingSummarizer().s, cache, opts);
  assert.equal(out[0]!.summary, "sum1"); // still summarised, just uncached
});

test("excerpt skips template scaffolding, code, links and markup", () => {
  const body = [
    "### Describe the bug",
    "",
    "The **save** button crashes the editor when the file is larger than 2 MB. See https://example.com/log for details.",
    "```",
    "Traceback (most recent call last): ...",
    "```",
    "### Expected behavior",
    "It should save. Third sentence is dropped.",
  ].join("\n");
  const out = excerpt(issue("a/b", 1, { body }))!;
  assert.ok(out.startsWith("Excerpt: The **save** button crashes") || out.startsWith("Excerpt: The save button crashes"));
  assert.ok(!out.includes("Traceback") && !out.includes("https://") && !out.includes("###"));
  assert.ok(!out.includes("Third sentence"));
});

test("excerpt is capped, labelled, and null for empty bodies", () => {
  const long = excerpt(issue("a/b", 1, { body: "word ".repeat(200) }))!;
  assert.ok(long.length <= "Excerpt: ".length + 281);
  assert.ok(long.endsWith("…"));
  assert.equal(excerpt(issue("a/b", 1, { body: "" })), null);
  assert.equal(excerpt(issue("a/b", 1, { body: "### Only a heading\n- [ ] checkbox" })), null);
});
