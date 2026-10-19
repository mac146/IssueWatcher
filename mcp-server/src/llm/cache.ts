import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { logger } from "../logger.js";
import type { Issue } from "../poller/types.js";
import { summarizeIssues, type Summarizer } from "./summarizer.js";

/**
 * Stores finished AI summaries so an issue is summarised once, however many
 * times it is seen, and across restarts and users when backed by Redis.
 * Implementations must never throw: a broken cache is a cache miss.
 */
export type SummaryCache = {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
};

/** Bump when the prompt or output format changes so old summaries are not reused. */
const KEY_VERSION = "v1";

/** Same repo, number, title and (truncated) body give the same key; an edited issue gets a fresh summary. */
export function summaryKey(issue: Issue, maxBodyChars: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([issue.repo, issue.number, issue.title, issue.body.slice(0, maxBodyChars)]))
    .digest("hex");
  return `issuewatcher:summary:${KEY_VERSION}:${digest}`;
}

export class MemoryCache implements SummaryCache {
  readonly kind = "memory";
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

/** The slice of an ioredis client that RedisCache uses (and tests can fake). */
export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
};

const WARN_EVERY_MS = 60_000;

export class RedisCache implements SummaryCache {
  readonly kind = "redis";
  private lastWarn = 0;

  constructor(
    private readonly client: RedisLike,
    private readonly now: () => number = Date.now,
  ) {}

  private warn(action: string, err: unknown): void {
    if (this.now() - this.lastWarn < WARN_EVERY_MS) return;
    this.lastWarn = this.now();
    logger.warn(`Redis ${action} failed; continuing without the cache`, err);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.warn("read", err);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      this.warn("write", err);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      /* already disconnected */
    }
  }
}

/**
 * Connects to Redis when a URL is given. If it cannot connect, logs one
 * warning and uses an in-memory cache instead: Redis is an optimisation, so
 * its absence must never stop the app.
 */
export async function createCache(redisUrl: string | null): Promise<SummaryCache> {
  if (!redisUrl) return new MemoryCache();

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    // Fail commands immediately while disconnected instead of queueing them.
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 1_000, 30_000),
  });
  client.on("error", () => undefined); // surfaced per command by RedisCache, not as unhandled events

  try {
    await client.connect();
    return new RedisCache(client);
  } catch (err) {
    logger.warn("Could not connect to Redis; using an in-memory cache", err);
    client.disconnect();
    return new MemoryCache();
  }
}

/**
 * Summarises items, asking the model only about issues without a cached
 * summary. Finished summaries are cached; failures are not, so they are
 * retried next cycle.
 */
export async function summarizeCached<T extends { issue: Issue }>(
  items: T[],
  summarizer: Summarizer,
  cache: SummaryCache,
  opts: { concurrency: number; batchSize: number; maxBodyChars: number; ttlSeconds: number },
): Promise<Array<T & { summary: string | null }>> {
  const keys = items.map((it) => summaryKey(it.issue, opts.maxBodyChars));
  const cached = await Promise.all(keys.map((k) => cache.get(k)));

  const missIndexes = cached.flatMap((hit, i) => (hit === null ? [i] : []));
  if (items.length > missIndexes.length) {
    logger.info(`Summary cache: ${items.length - missIndexes.length} hit(s), ${missIndexes.length} to summarise`);
  }

  const fresh = await summarizeIssues(
    missIndexes.map((i) => items[i]!),
    summarizer,
    { concurrency: opts.concurrency, batchSize: opts.batchSize },
  );

  const results = items.map((item, i) => ({ ...item, summary: cached[i] ?? null }));
  await Promise.all(
    fresh.map(async (entry, n) => {
      const i = missIndexes[n]!;
      results[i]!.summary = entry.summary;
      if (entry.summary) await cache.set(keys[i]!, entry.summary, opts.ttlSeconds);
    }),
  );
  return results;
}
